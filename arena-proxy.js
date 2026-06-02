import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

const PORT = Number(process.env.PORT || 9228);
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";

const DEFAULT_MODEL_ID = process.env.ARENA_DEFAULT_MODEL_ID || "019b24bb-5caf-71c3-b854-37d0c7086f21";
const ARENA_MODALITY = process.env.ARENA_MODALITY || "chat";
const ARENA_SESSION_URL = (process.env.ARENA_SESSION_URL || "http://127.0.0.1:9230").replace(/\/+$/, "");

const PI_AGENT_CONTRACT = `You are a precise, pragmatic software engineering agent.
Your priorities are correctness, evidence, minimal safe changes, and clear concise communication.
Do not guess about files, APIs, commands, package scripts, config, errors, or project structure. Inspect with tools first.
Before answering questions about the current workspace, use read/list/search tools unless the answer is already present in the conversation.
Before editing code, inspect the relevant files and understand the existing style. Make the smallest correct change.
Never claim you changed, tested, installed, ran, or verified something unless a tool result proves it.
If a command fails, use the error output to diagnose and continue with a smaller next step when safe.
Do not overwrite or revert user work unless explicitly asked. Treat unexpected file changes as user-owned.
Avoid broad refactors, new abstractions, and compatibility layers unless the user asks or the existing code clearly requires them.
Prefer concrete file paths, command names, and observed outputs over general explanations.
When implementation is requested, act instead of only proposing. When the user asks a question, answer directly after gathering enough evidence.
For code review, prioritize bugs, regressions, missing tests, and risks before summaries.
For frontend work, preserve the existing design system unless the user asks for redesign.
Security: do not expose secrets, tokens, cookies, private keys, or credential files. Do not print sensitive file contents unless explicitly required and safe.
Use Portuguese when the user writes Portuguese. Keep final answers concise and factual.`;

const PI_TOOL_CONTRACT = `You are running through an OpenAI-compatible proxy backed by Arena AI.
Tools are available for you to execute.
When a tool is needed, your ENTIRE response must be ONLY the tool call and nothing else.
Do not answer the result of a command or file operation yourself; that result only exists after the tool executes.
Prefer small, verifiable tool calls over one huge shell command.
For multi-file work, create directories, write one or a few files, then verify with a listing command.
When creating files, verify that required files are non-empty and contain the expected kind of content, not only that paths exist.
Use exactly this form, with valid JSON inside:
<tool_call>{"name":"tool_name","arguments":{"arg":"value"}}</tool_call>
Never put tool calls in Markdown code fences.
Never explain a tool call before or after emitting it.
The arguments object must match the selected tool schema exactly.
Never include fields that are not listed in the tool schema inside arguments.
Descriptions, comments, labels, reasons, or explanations are NOT tool arguments unless the schema explicitly lists them.
For bash, command and timeout are separate fields, for example:
<tool_call>{"name":"bash","arguments":{"command":"pwd","timeout":10}}</tool_call>
For bash, do NOT put description inside arguments. If a description exists, it is metadata outside the model tool-call payload and must be omitted.
Do not produce malformed JSON.
Use Portuguese when the user writes Portuguese, unless the task requires code or exact command output.`;

let requestQueue = Promise.resolve();

function log(...args) { console.log("[arena-proxy]", ...args); }

function logRequest(event, data = {}) {
  const safe = { ...data };
  if (safe.cookie) safe.cookie = `<${String(safe.cookie).length} chars>`;
  if (safe.recaptchaToken) safe.recaptchaToken = `<${String(safe.recaptchaToken).length} chars>`;
  console.log(`[arena-proxy] ${event}`, JSON.stringify(safe));
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  });
  res.end(JSON.stringify(data));
}

function isAuthorized(req) {
  if (!PROXY_API_KEY) return true;
  const auth = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const apiKey = Array.isArray(req.headers["x-api-key"]) ? req.headers["x-api-key"][0] : req.headers["x-api-key"];
  return auth === `Bearer ${PROXY_API_KEY}` || apiKey === PROXY_API_KEY;
}

function apiError(res, status, message, type = "server_error", code = null) {
  json(res, status, { error: { message, type, code } });
}
function unauthorized(res) { apiError(res, 401, "Unauthorized"); }

function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const now = BigInt(Date.now());
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function lastUserText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map((p) => typeof p === "string" ? p : p?.text || "").filter(Boolean).join("\n");
  }
  return String(last.content || "");
}

function messageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return part?.text || JSON.stringify(part);
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function describeTool(tool) {
  const fn = tool?.function || tool || {};
  const params = fn.parameters || {};
  const props = params.properties || {};
  const required = Array.isArray(params.required) ? params.required : [];
  const args = Object.entries(props).map(([name, schema]) => {
    const req = required.includes(name) ? "required" : "optional";
    const type = schema?.type || "any";
    const desc = schema?.description ? ` - ${String(schema.description).slice(0, 80)}` : "";
    return `${name}: ${type} (${req})${desc}`;
  }).join(", ");
  const desc = fn.description ? `\n  description: ${String(fn.description).slice(0, 160)}` : "";
  return `- ${fn.name}${desc}\n  allowed argument keys only: { ${args} }`;
}

function toolsEnabled(params) {
  return Array.isArray(params?.tools) && params.tools.length > 0 && params.tool_choice !== "none";
}

function buildPrompt(params) {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const tools = toolsEnabled(params) ? params.tools : [];
  const choice = params?.tool_choice;
  const parts = [];

  if (Array.isArray(params.tools) && params.tools.length > 0 && choice === "none") {
    parts.push([
      "Tool use disabled:",
      "The client supplied tools, but tool_choice is none.",
      "Do not output <tool_call> tags. Answer normally in text.",
    ].join("\n"));
  }

  if (tools.length > 0) {
    const contractLines = [
      "Tool calling mode — you have access to tools that can execute commands, read files, search code, and more.",
      "When a tool call is needed, your ENTIRE response must be ONLY the tool call and nothing else.",
      "Do not answer tool results yourself. A tool result only exists after the tool executes.",
      "Format:",
      '<tool_call>{"name":"tool_name","arguments":{"arg":"value"}}</tool_call>',
      "Never put metadata fields such as description, title, rationale, or explanation inside arguments.",
      "The arguments object must match the selected tool schema exactly.",
    ];
    if (choice === "required") {
      contractLines.push("", "tool_choice is required. You MUST call a tool. Do not answer in normal text.");
    } else if (choice && typeof choice === "object" && choice.function?.name) {
      contractLines.push("", `You MUST call the tool named "${choice.function.name}". Do not answer in normal text.`);
    }
    contractLines.push("", "Available tools:", ...tools.map(describeTool));
    parts.push(contractLines.join("\n"));
  }

  for (const message of messages) {
    const role = message?.role || "user";
    if (role === "developer") {
      const content = messageContent(message?.content);
      if (content) parts.push(`developer instructions:\n${content}`);
      continue;
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      parts.push(`assistant tool calls:\n${JSON.stringify(message.tool_calls, null, 2)}`);
      continue;
    }
    const name = message?.name ? ` ${message.name}` : "";
    const content = messageContent(message?.content);
    if (role === "tool" || role === "function" || role === "toolResult") {
      let toolName = message?.name || "tool";
      if (message?.tool_call_id) {
        for (const previous of [...parts].reverse()) {
          const match = String(previous).match(/"name"\s*:\s*"([^"]+)"/);
          if (match) { toolName = match[1]; break; }
        }
      }
      parts.push(`Tool Response (${toolName}):\n${content}`);
      continue;
    }
    if (!content) continue;
    parts.push(`${role}${name}:\n${content}`);
  }

  return parts.join("\n\n").trim() || lastUserText(messages);
}

function allowedToolArgs(name, args, tools = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const tool = tools.find((item) => {
    const fn = item?.function || item || {};
    return fn.name === name;
  });
  const params = (tool?.function || tool || {})?.parameters || {};
  const props = params.properties || {};
  const allowExtra = params.additionalProperties === true;
  const allowed = new Set(Object.keys(props));
  if (allowExtra || allowed.size === 0) return args;
  const filtered = {};
  for (const [key, value] of Object.entries(args)) {
    if (allowed.has(key)) filtered[key] = value;
  }
  return filtered;
}

function findMatchingBrace(raw, start) {
  if (raw[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function parseToolCalls(text, tools = []) {
  const calls = [];
  let remaining = text || "";
  const parts = [];
  const parsePayload = (raw) => {
    const attempts = [raw, raw.replace(/>\s*$/, "")];
    const braceEnd = findMatchingBrace(raw, raw.indexOf("{"));
    if (braceEnd !== -1) attempts.push(raw.slice(0, braceEnd + 1));
    for (const attempt of attempts) {
      try { return JSON.parse(attempt); }
      catch {}
    }
    return null;
  };
  const normalizedCalls = (parsed) => {
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tool_calls)
      ? parsed.tool_calls
      : [parsed];
    return items.map((item) => {
      const fn = item?.function || item || {};
      let args = fn.arguments ?? item?.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); }
        catch {}
      }
      const name = fn.name || item?.name || "";
      return { name, arguments: allowedToolArgs(name, args, tools) };
    }).filter((item) => item.name);
  };
  const pushParsed = (parsed) => {
    for (const item of normalizedCalls(parsed)) {
      calls.push({
        id: "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
    }
  };
  while (true) {
    const start = remaining.indexOf("<tool_call>");
    if (start === -1) { parts.push(remaining); break; }
    parts.push(remaining.slice(0, start));
    const end = remaining.indexOf("</tool_call>", start + 11);
    const raw = end === -1
      ? remaining.slice(start + 11).trim()
      : remaining.slice(start + 11, end).trim();
    const parsed = parsePayload(raw);
    if (parsed) pushParsed(parsed);
    else parts.push(`<tool_call>${raw}</tool_call>`);
    if (end === -1) break;
    remaining = remaining.slice(end + 12);
  }
  if (calls.length === 0) {
    const stripped = String(text || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    const parsed = parsePayload(stripped);
    if (parsed && normalizedCalls(parsed).length > 0) {
      pushParsed(parsed);
      return { textContent: "", toolCalls: calls };
    }
  }
  return { textContent: parts.join("").trim(), toolCalls: calls };
}

function parseArenaSse(text) {
  const chunks = [];
  let finish = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("a0:")) {
      try { chunks.push(JSON.parse(line.slice(3))); }
      catch { chunks.push(line.slice(3)); }
    } else if (line.startsWith("ad:")) {
      try { finish = JSON.parse(line.slice(3)); }
      catch {}
    }
  }
  return { text: chunks.join(""), finish };
}

function estimateTokens(text) {
  const value = String(text || "").trim();
  if (!value) return 0;
  const words = value.split(/\s+/).filter(Boolean).length;
  const chars = value.length;
  return Math.max(1, Math.ceil(Math.max(words * 1.35, chars / 4)));
}

function usageFromText(prompt, completion, finish = null) {
  const realPrompt = finish?.usage?.prompt_tokens ?? finish?.usage?.input_tokens ?? finish?.prompt_tokens ?? finish?.input_tokens;
  const realCompletion = finish?.usage?.completion_tokens ?? finish?.usage?.output_tokens ?? finish?.completion_tokens ?? finish?.output_tokens;
  const promptTokens = Number.isFinite(Number(realPrompt)) ? Number(realPrompt) : estimateTokens(prompt);
  const completionTokens = Number.isFinite(Number(realCompletion)) ? Number(realCompletion) : estimateTokens(completion);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 },
    estimated: realPrompt === undefined || realCompletion === undefined,
  };
}

async function arenaChat(prompt, modelId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(`${ARENA_SESSION_URL}/arena/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        modelId,
        id: uuidv7(),
        userMessageId: uuidv7(),
        modelMessageId: uuidv7(),
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data.ok) {
      const status = data.status || 500;
      const err = new Error(`Arena ${status}: ${(data.text || data.error || "").slice(0, 500)}`);
      if (status === 429 || status === 401) {
        err.retryable = true;
        err.is429 = status === 429;
        err.accountId = data.accountId;
      }
      throw err;
    }
    logRequest("arena:chat:ok", { account: data.accountLabel, status: data.status, bytes: (data.text || "").length, modelId });
    return { status: data.status, text: data.text, accountId: data.accountId };
  } finally {
    clearTimeout(timer);
  }
}

function streamJson(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamChoice(delta, finishReason = null) {
  return { index: 0, delta, logprobs: null, finish_reason: finishReason };
}

function streamOpenAICompletion(res, streamState, text, parsed, includeRole = true, usage = null) {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": heartbeat\n\n");
  }
  if (includeRole) {
    streamJson(res, {
      id: streamState.id,
      object: "chat.completion.chunk",
      created: streamState.created,
      model: streamState.model,
      choices: [streamChoice({ role: "assistant", content: null })],
    });
  }
  if (parsed.toolCalls.length > 0) {
    parsed.toolCalls.forEach((call, index) => {
      streamJson(res, {
        id: streamState.id,
        object: "chat.completion.chunk",
        created: streamState.created,
        model: streamState.model,
        choices: [streamChoice({
          tool_calls: [{
            index,
            id: call.id,
            type: call.type,
            function: { name: call.function.name, arguments: "" },
          }],
        })],
      });
      streamJson(res, {
        id: streamState.id,
        object: "chat.completion.chunk",
        created: streamState.created,
        model: streamState.model,
        choices: [streamChoice({
          tool_calls: [{
            index,
            function: { arguments: call.function.arguments },
          }],
        })],
      });
    });
  } else if (parsed.textContent) {
    streamJson(res, {
      id: streamState.id,
      object: "chat.completion.chunk",
      created: streamState.created,
      model: streamState.model,
      choices: [streamChoice({ content: parsed.textContent })],
    });
  }
  const finishData = {
    id: streamState.id,
    object: "chat.completion.chunk",
    created: streamState.created,
    model: streamState.model,
    choices: [streamChoice({}, parsed.toolCalls.length > 0 ? "tool_calls" : "stop")],
  };
  if (usage) finishData.usage = usage;
  streamJson(res, finishData);
  res.write("data: [DONE]\n\n");
  res.end();
}

function modelIdFromRequest(params) {
  const model = params?.model || "";
  return resolveModelId(model === "chatgpt-web" ? "arena-default" : model);
}

function resolveModelId(openAiModel) {
  if (!openAiModel || openAiModel === "arena-default") return DEFAULT_MODEL_ID;
  return openAiModel;
}

function loadArenaTextModels() {
  const file = path.join(__dirname, "data", "models-list.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const jsonText = raw.slice(0, raw.lastIndexOf("]") + 1);
    const models = JSON.parse(jsonText);
    const seen = new Set();
    return models
      .filter((model) => model?.id && model.userSelectable !== false && Array.isArray(model.output) && model.output.includes("text"))
      .sort((a, b) => (a.rankChat || a.rank || 999999) - (b.rankChat || b.rank || 999999))
      .filter((model) => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      });
  } catch (err) {
    log("Could not load data/models-list.json:", err.message);
    return [];
  }
}

function modelList() {
  const created = Math.floor(Date.now() / 1000);
  const base = [{ id: "arena-default", object: "model", created, owned_by: "arena", name: "Arena AI Default Chat" }];
  const loaded = loadArenaTextModels().map((model) => ({
    id: model.id,
    object: "model",
    created,
    owned_by: model.org || model.provider || "arena",
    name: model.name || model.displayName || model.id,
    rank: model.rank,
    rankChat: model.rankChat,
    input: model.input,
    output: model.output,
  }));
  if (!loaded.some((model) => model.id === DEFAULT_MODEL_ID)) {
    loaded.unshift({ id: DEFAULT_MODEL_ID, object: "model", created, owned_by: "arena", name: "Arena AI Max Chat" });
  }
  return [...base, ...loaded];
}

http.createServer((req, res) => {
  const requestPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    });
    res.end();
    return;
  }

  if (req.method === "POST" && requestPath === "/v1/chat/completions") {
    if (!isAuthorized(req)) { unauthorized(res); return; }
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      let params;
      try { params = JSON.parse(body); }
      catch (err) { apiError(res, 400, `Invalid JSON: ${err.message}`); return; }

      requestQueue = requestQueue.then(async () => {
        try {
          const prompt = buildPrompt(params);
          if (!prompt) throw new Error("No user message");

          const modelId = modelIdFromRequest(params);
          const stream = params.stream === true;

          logRequest("request:start", {
            model: params.model || "arena-default",
            resolvedModel: modelId,
            modality: ARENA_MODALITY,
            stream,
            tools: Array.isArray(params.tools) ? params.tools.length : 0,
            messages: Array.isArray(params.messages) ? params.messages.length : 0,
            promptChars: prompt.length,
          });

          const result = await arenaChat(prompt, modelId);

          const parsed = parseArenaSse(result.text);
          const fullText = parsed.text || "";
          const allowToolCalls = toolsEnabled(params);
          const toolParsed = allowToolCalls
            ? parseToolCalls(fullText, params.tools || [])
            : { textContent: fullText, toolCalls: [] };
          const usage = usageFromText(prompt, fullText, parsed.finish);
          const hasTools = allowToolCalls;

          if (stream) {
            const streamState = {
              id: `chatcmpl-${Date.now()}`,
              created: Math.floor(Date.now() / 1000),
              model: params.model || "arena",
            };

            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            });
            res.write(": heartbeat\n\n");

            if (hasTools && toolParsed.toolCalls.length > 0) {
              streamOpenAICompletion(res, streamState, fullText, toolParsed, true, usage);
            } else {
              streamJson(res, {
                id: streamState.id, object: "chat.completion.chunk",
                created: streamState.created, model: streamState.model,
                choices: [streamChoice({ role: "assistant", content: null })],
              });
              if (fullText) {
                streamJson(res, {
                  id: streamState.id, object: "chat.completion.chunk",
                  created: streamState.created, model: streamState.model,
                  choices: [streamChoice({ content: fullText })],
                });
              }
              streamJson(res, {
                id: streamState.id, object: "chat.completion.chunk",
                created: streamState.created, model: streamState.model,
                choices: [streamChoice({}, toolParsed.toolCalls.length > 0 ? "tool_calls" : "stop")],
                usage,
              });
              res.write("data: [DONE]\n\n");
              res.end();
            }
            logRequest("request:stream:ok", { model: params.model || "arena-default", finishReason: toolParsed.toolCalls.length > 0 ? "tool_calls" : "stop", contentChars: toolParsed.textContent.length, toolCalls: toolParsed.toolCalls.length, usage });
          } else {
            json(res, 200, {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: params.model || "arena",
              choices: [{
                index: 0,
                message: toolParsed.toolCalls.length > 0
                  ? { role: "assistant", content: null, tool_calls: toolParsed.toolCalls }
                  : { role: "assistant", content: toolParsed.textContent },
                finish_reason: toolParsed.toolCalls.length > 0 ? "tool_calls" : "stop",
              }],
              usage,
            });
            logRequest("request:ok", { model: params.model || "arena-default", finishReason: toolParsed.toolCalls.length > 0 ? "tool_calls" : "stop", contentChars: toolParsed.textContent.length, toolCalls: toolParsed.toolCalls.length, usage });
          }
        } catch (err) {
          log("ERROR:", err.message);
          const status = err.is429 ? 429 : 500;
          if (!res.headersSent) apiError(res, status, err.message);
          else {
            streamJson(res, { error: { message: err.message } });
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }
      });
    });
    return;
  }

  if (req.method === "POST" && requestPath === "/api/session/new") {
    if (!isAuthorized(req)) { unauthorized(res); return; }
    json(res, 200, { ok: true });
    return;
  }

  if (requestPath === "/v1/models" || requestPath === "/models") {
    if (!isAuthorized(req)) { unauthorized(res); return; }
    json(res, 200, { object: "list", data: modelList() });
    return;
  }

  apiError(res, 404, "Not found");
}).listen(PORT, () => {
  log(`Running on http://localhost:${PORT}`);
  log(`Default model: ${DEFAULT_MODEL_ID}`);
  log(`Modality: ${ARENA_MODALITY}`);
  log(`Arena session: ${ARENA_SESSION_URL}`);
  if (PROXY_API_KEY) log("API key auth enabled");
});
