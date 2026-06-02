import http from "node:http";
import https from "node:https";
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
const ARENA_COOKIE = process.env.ARENA_COOKIE || "";
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
When a tool is needed, output only tool calls and nothing else.
Do not answer the result of a command or file operation yourself; that result only exists after the tool executes.
Prefer small, verifiable tool calls over one huge shell command.
For multi-file work, create directories, write one or a few files, then verify with a listing command.
When creating files, verify that required files are non-empty and contain the expected kind of content, not only that paths exist.
Use exactly this form, with valid JSON inside:
<tool_call>{"name":"tool_name","arguments":{"arg":"value"}}</tool_call>
Never put tool calls in Markdown code fences.
Never explain a tool call before or after emitting it.
The arguments object must match the selected tool schema exactly.
For bash, command and timeout are separate fields, for example:
<tool_call>{"name":"bash","arguments":{"command":"pwd","timeout":10}}</tool_call>
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

function unauthorized(res) { json(res, 401, { error: "Unauthorized" }); }

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

async function sessionJson(path, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ARENA_SESSION_URL}${path}`, { signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Arena session non-JSON ${res.status}: ${text.slice(0, 200)}`); }
    if (!res.ok || data?.ok === false) {
      const actions = Array.isArray(data?.nextActions) ? ` Next actions: ${data.nextActions.join(" | ")}` : "";
      throw new Error(`${data?.code || "arena_session_error"}: ${data?.error || `HTTP ${res.status}`}.${actions}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getRecaptchaToken() {
  logRequest("recaptcha:playwright:start", { session: ARENA_SESSION_URL });
  const data = await sessionJson("/recaptcha", 45000);
  logRequest("recaptcha:playwright:ok", { tokenLength: data?.token?.length || 0 });
  if (!data?.token) throw new Error("Playwright session did not return a reCAPTCHA token");
  return data.token;
}

async function getCookies() {
  if (ARENA_COOKIE) {
    logRequest("cookies:env", { length: ARENA_COOKIE.length });
    return ARENA_COOKIE;
  }
  logRequest("cookies:playwright:start", { session: ARENA_SESSION_URL });
  const data = await sessionJson("/cookies", 15000);
  if (!data?.cookieHeader) throw new Error("Playwright session did not return Arena cookies");
  logRequest("cookies:playwright:ok", { length: data.cookieHeader.length });
  return data.cookieHeader;
}

function lastUserText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map((p) => typeof p === "string" ? p : p?.text || "").filter(Boolean).join("\n");
  }
  return String(last.content || "");
}

function hasToolResult(messages) {
  return (messages || []).some((m) => m?.role === "tool" || m?.role === "toolResult");
}

function explicitlyRequestsTool(text) {
  return /\b(tool|ferramenta|bash|command|comando|run|rodar|execute|executar|pwd|read|ler|list|listar|grep|find|edit|editar|write|escrever)\b/i.test(String(text || ""));
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
  const desc = fn.description ? `: ${String(fn.description).slice(0, 160)}` : "";
  return `- ${fn.name}${desc}\n  arguments: { ${args} }`;
}

function toolCallRequired(params) {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  return Array.isArray(params?.tools)
    && params.tools.length > 0
    && explicitlyRequestsTool(lastUserText(messages))
    && !hasToolResult(messages);
}

function buildPrompt(params) {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const parts = [];

  if (tools.length > 0) {
    parts.push([
      "Tool calling mode:",
      "If the user asks to use a tool, answer with exactly one tool call and no other text.",
      "Format:",
      '<tool_call>{"name":"tool_name","arguments":{}}</tool_call>',
      "Available tools:",
      tools.map(describeTool).join("\n"),
    ].join("\n"));
  }

  if (tools.length > 0 && toolCallRequired(params)) {
    parts.push([
      "The latest user explicitly requested a tool.",
      "Your next response MUST be only one valid <tool_call>{...}</tool_call> wrapper.",
      "Do not explain. Do not include Markdown.",
      "Available tools:",
      tools.map(describeTool).join("\n"),
    ].join("\n"));
  }

  for (const message of messages) {
    const role = message?.role || "user";
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      parts.push(`assistant tool calls:\n${JSON.stringify(message.tool_calls, null, 2)}`);
      continue;
    }
    const name = message?.name ? ` ${message.name}` : "";
    const content = messageContent(message?.content);
    if (!content && role !== "tool") continue;
    parts.push(`${role}${name}:\n${content}`);
  }

  return parts.join("\n\n").trim() || lastUserText(messages);
}

function parseToolCalls(text) {
  const calls = [];
  let remaining = text || "";
  const parts = [];
  const parsePayload = (raw) => {
    const attempts = [raw, raw.replace(/>\s*$/, "")];
    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace !== -1) attempts.push(raw.slice(0, lastBrace + 1));
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
      return { name: fn.name || item?.name || "", arguments: args };
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
    estimated: realPrompt === undefined || realCompletion === undefined,
  };
}

function makeArenaPayload(prompt, modelId) {
  return {
    id: uuidv7(),
    mode: "direct-battle",
    modelAId: modelId || DEFAULT_MODEL_ID,
    userMessageId: uuidv7(),
    modelAMessageId: uuidv7(),
    userMessage: {
      content: prompt,
      experimental_attachments: [],
      metadata: {},
    },
    modality: ARENA_MODALITY,
    recaptchaV3Token: null,
  };
}

async function arenaDirectCall(prompt, modelId, cookie, recaptchaToken) {
  const started = Date.now();
  const payload = makeArenaPayload(prompt, modelId);
  payload.recaptchaV3Token = recaptchaToken;

  const body = JSON.stringify(payload);
  const url = new URL("https://arena.ai/nextjs-api/stream/create-evaluation");

  return new Promise((resolve, reject) => {
    const opts = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cookie": cookie,
        "Accept": "text/event-stream",
        "Origin": "https://arena.ai",
        "Referer": "https://arena.ai/code/direct",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36",
      },
      timeout: 120000,
    };

    const req = https.request(opts, (res) => {
      const contentType = res.headers["content-type"] || "";
      if (contentType.includes("event-stream")) {
        let buffer = "";
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { res.destroy(); } catch {}
          logRequest("arena:direct:done", { status: res.statusCode, ms: Date.now() - started, bytes: buffer.length, modelId, modality: ARENA_MODALITY });
          resolve({ status: res.statusCode, headers: res.headers, text: buffer });
        };
        const timer = setTimeout(() => finish(), 120000);
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          if (buffer.includes('"finishReason"')) finish();
        });
        res.on("end", () => finish());
        res.on("error", (e) => { if (!settled) reject(e); });
      } else {
        let data = "";
        const timer = setTimeout(() => reject(new Error("Timeout")), 120000);
        res.setEncoding("utf8");
        res.on("data", (c) => data += c);
        res.on("end", () => {
          clearTimeout(timer);
          logRequest("arena:direct:done", { status: res.statusCode, ms: Date.now() - started, bytes: data.length, modelId, modality: ARENA_MODALITY });
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      }
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function arenaStreamCall(prompt, modelId, cookie, recaptchaToken, onText, onFinish, onError) {
  const started = Date.now();
  const payload = makeArenaPayload(prompt, modelId);
  payload.recaptchaV3Token = recaptchaToken;

  const body = JSON.stringify(payload);
  const url = new URL("https://arena.ai/nextjs-api/stream/create-evaluation");

  const opts = {
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cookie": cookie,
      "Accept": "text/event-stream",
      "Origin": "https://arena.ai",
      "Referer": "https://arena.ai/code/direct",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    timeout: 120000,
  };

  const req = https.request(opts, (res) => {
    res.setEncoding("utf8");
    let raw = "";
    let pending = "";
    res.on("data", (chunk) => {
      raw += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("a0:")) {
          try {
            const val = JSON.parse(line.slice(3));
            if (typeof val === "string") onText(val);
          } catch {}
        }
      }
    });
    res.on("end", () => {
      if (pending.startsWith("a0:")) {
        try {
          const val = JSON.parse(pending.slice(3));
          if (typeof val === "string") onText(val);
        } catch {}
      }
      const parsed = parseArenaSse(raw + pending);
      logRequest("arena:stream:done", { status: res.statusCode, ms: Date.now() - started, bytes: raw.length + pending.length, modelId, modality: ARENA_MODALITY, finishReason: parsed.finish?.finishReason });
      onFinish(parsed.finish);
    });
    res.on("error", onError);
  });
  req.on("error", onError);
  req.on("timeout", () => { req.destroy(); onError(new Error("timeout")); });
  req.write(body);
  req.end();
}

function streamJson(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamOpenAICompletion(res, streamState, text, parsed, includeRole = true) {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
  }
  if (includeRole) {
    streamJson(res, {
      id: streamState.id,
      object: "chat.completion.chunk",
      created: streamState.created,
      model: streamState.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  }
  if (parsed.toolCalls.length > 0) {
    parsed.toolCalls.forEach((call, index) => {
      streamJson(res, {
        id: streamState.id,
        object: "chat.completion.chunk",
        created: streamState.created,
        model: streamState.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: call.id,
              type: call.type,
              function: call.function,
            }],
          },
          finish_reason: null,
        }],
      });
    });
  } else if (parsed.textContent) {
    streamJson(res, {
      id: streamState.id,
      object: "chat.completion.chunk",
      created: streamState.created,
      model: streamState.model,
      choices: [{ index: 0, delta: { content: parsed.textContent }, finish_reason: null }],
    });
  }
  streamJson(res, {
    id: streamState.id,
    object: "chat.completion.chunk",
    created: streamState.created,
    model: streamState.model,
    choices: [{ index: 0, delta: {}, finish_reason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop" }],
  });
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
      catch (err) { json(res, 400, { error: `Invalid JSON: ${err.message}` }); return; }

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

          const cookie = await getCookies();
          if (!cookie) throw new Error("No Arena cookie available");

          const recaptchaToken = await getRecaptchaToken();

          if (stream) {
            const collected = [];
            const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
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

            streamJson(res, {
              id: streamState.id,
              object: "chat.completion.chunk",
              created: streamState.created,
              model: streamState.model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            });

            await new Promise((resolvePromise, rejectPromise) => {
              arenaStreamCall(
                prompt,
                modelId,
                cookie,
                recaptchaToken,
                (text) => {
                  collected.push(text);
                  if (!hasTools) {
                    streamJson(res, {
                      id: streamState.id,
                      object: "chat.completion.chunk",
                      created: streamState.created,
                      model: streamState.model,
                      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                    });
                  }
                },
                (finish) => {
                  const fullText = collected.join("");
                  const usage = usageFromText(prompt, fullText, finish);
                  if (hasTools) {
                    const parsed = parseToolCalls(fullText);
                    logRequest("request:stream:ok", { model: params.model || "arena-default", finishReason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop", contentChars: parsed.textContent.length, toolCalls: parsed.toolCalls.length, usage });
                    streamOpenAICompletion(res, streamState, fullText, parsed, false);
                  } else {
                    logRequest("request:stream:ok", { model: params.model || "arena-default", finishReason: finish?.finishReason || "stop", contentChars: fullText.length, toolCalls: 0, usage });
                    streamJson(res, {
                      id: streamState.id,
                      object: "chat.completion.chunk",
                      created: streamState.created,
                      model: streamState.model,
                      choices: [{ index: 0, delta: {}, finish_reason: finish?.finishReason || "stop" }],
                    });
                    res.write("data: [DONE]\n\n");
                    res.end();
                  }
                  resolvePromise();
                },
                (err) => {
                  if (!res.headersSent) {
                    json(res, 500, { error: err.message });
                  } else {
                    streamJson(res, { error: err.message });
                    res.write("data: [DONE]\n\n");
                    res.end();
                  }
                  rejectPromise(err);
                }
              );
            });
          } else {
            const result = await arenaDirectCall(prompt, modelId, cookie, recaptchaToken);
            if (result.status !== 200) {
              logRequest("request:error", { model: params.model || "arena-default", status: result.status, body: result.text.slice(0, 300) });
              throw new Error(`Arena ${result.status}: ${result.text.slice(0, 500)}`);
            }
            const parsed = parseArenaSse(result.text);
            const toolParsed = parseToolCalls(parsed.text);
            const usage = usageFromText(prompt, parsed.text, parsed.finish);

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
          if (!res.headersSent) json(res, 500, { error: err.message });
          else {
            streamJson(res, { error: err.message });
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

  json(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  log(`Running on http://localhost:${PORT}`);
  log(`Default model: ${DEFAULT_MODEL_ID}`);
  log(`Modality: ${ARENA_MODALITY}`);
  log(`Arena session: ${ARENA_SESSION_URL}`);
  if (PROXY_API_KEY) log("API key auth enabled");
  if (ARENA_COOKIE) log(`Cookie loaded from env (${ARENA_COOKIE.length} chars)`);
  else log("No cookie in env, will fetch from Playwright session");
});
