const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.ARENA_SESSION_PORT || 9230);
const START_URL = process.env.ARENA_LOGIN_URL || "https://arena.ai/text/direct";
const PROFILE_DIR = process.env.ARENA_PROFILE_DIR || path.join(__dirname, ".playwright-arena-profile");
const BROWSER_CHANNEL = process.env.ARENA_BROWSER_CHANNEL || "chrome";
const ENV_PATH = path.join(__dirname, ".env");
const SITE_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";

let context = null;
let page = null;
let lastCookieSavedAt = 0;
let lastRecaptchaAt = 0;
let browserStartedAt = 0;

function log(message) {
  console.log(`[arena-session] ${message}`);
}

function loadDotEnv(filePath = ENV_PATH) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function quoteEnv(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function upsertEnv(updates) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${quoteEnv(updates[match[1]])}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${quoteEnv(value)}`);
  }
  fs.writeFileSync(ENV_PATH, next.filter((line, index, arr) => line || index < arr.length - 1).join("\n") + "\n");
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function agentError(code, message, nextActions = [], details = {}) {
  return { ok: false, code, error: message, nextActions, details };
}

async function getArenaCookies() {
  if (!context) throw new Error("Playwright context is not ready");
  const cookies = await context.cookies();
  return cookies.filter((cookie) => String(cookie.domain || "").includes("arena.ai"));
}

function cookieHeader(cookies) {
  const preferred = ["arena-auth-prod-v1.0", "cf_clearance", "user_country_code"];
  const byName = new Map(cookies.map((cookie) => [cookie.name, cookie]));
  const ordered = [];
  for (const name of preferred) {
    if (byName.has(name)) ordered.push(byName.get(name));
  }
  for (const cookie of cookies) {
    if (!preferred.includes(cookie.name)) ordered.push(cookie);
  }
  return ordered.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function saveCookiesToEnv() {
  const cookies = await getArenaCookies();
  const header = cookieHeader(cookies);
  if (!header.includes("arena-auth-prod-v1.0")) {
    return agentError("arena_login_missing", "Arena auth cookie was not found yet", [
      "Finish logging in on the Playwright browser window.",
      "After login, open https://arena.ai/text/direct in that same window.",
      "Then call GET /cookies/save or wait for the session service to auto-save.",
    ], { cookieCount: cookies.length });
  }
  upsertEnv({
    ARENA_COOKIE: header,
    ARENA_SESSION_URL: `http://127.0.0.1:${PORT}`,
  });
  process.env.ARENA_COOKIE = header;
  lastCookieSavedAt = Date.now();
  log(`cookies salvos no .env (${cookies.length} cookies, header ${header.length} caracteres)`);
  return { ok: true, cookieCount: cookies.length, headerLength: header.length, savedAt: lastCookieSavedAt, env: ENV_PATH };
}

async function waitForLoginAndSave() {
  const deadline = Date.now() + Number(process.env.ARENA_LOGIN_WAIT_MS || 10 * 60 * 1000);
  while (Date.now() < deadline) {
    const result = await saveCookiesToEnv().catch(() => null);
    if (result?.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  log("tempo de espera do login esgotado; faça login e acesse /cookies/save para salvar manualmente");
}

async function recaptchaToken() {
  if (!page || page.isClosed()) throw new Error("Arena page is not open");
  await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute, null, { timeout: 30000 });
  const token = await page.evaluate((siteKey) => {
    return window.grecaptcha.enterprise.execute(siteKey, { action: "chat_submit" });
  }, SITE_KEY);
  lastRecaptchaAt = Date.now();
  log(`reCAPTCHA gerado (${String(token || "").length} caracteres)`);
  return token;
}

async function startBrowser() {
  loadDotEnv();
  let playwright;
  try {
    playwright = require("playwright");
  } catch (err) {
    console.error("[arena-session] dependência ausente: playwright");
    console.error("[arena-session] execute: npm install");
    throw err;
  }

  const launchOptions = {
    headless: false,
    channel: BROWSER_CHANNEL,
    viewport: { width: 1366, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-default-browser-check",
      "--no-first-run",
      "--start-maximized",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  try {
    context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  } catch (err) {
    log(`falha ao abrir channel=${BROWSER_CHANNEL}: ${err.message}`);
    log("usando Chromium embutido como fallback; o login do Google pode rejeitar esse navegador");
    const { channel, ...fallbackOptions } = launchOptions;
    context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, fallbackOptions);
  }

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    } catch {}
  });
  browserStartedAt = Date.now();
  page = context.pages()[0] || await context.newPage();
  page.on("close", async () => {
    if (!context) return;
    const existing = context.pages().find((candidate) => !candidate.isClosed());
    if (existing) {
      page = existing;
      return;
    }
    log("última página fechada; serviço continua ativo sem forçar nova aba");
    page = null;
  });
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  log(`página aberta: ${START_URL}`);
  log("faça login na janela aberta; os cookies serão salvos automaticamente");
  waitForLoginAndSave().catch((err) => log(`salvamento automático falhou: ${err.message}`));
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/status") {
      const cookies = await getArenaCookies().catch(() => []);
      return json(res, 200, {
        ok: true,
        startedAt: browserStartedAt,
        url: page?.url?.() || null,
        pageOpen: !!page && !page.isClosed(),
        cookieCount: cookies.length,
        hasArenaAuth: cookies.some((cookie) => cookie.name === "arena-auth-prod-v1.0"),
        lastCookieSavedAt,
        lastRecaptchaAt,
        env: ENV_PATH,
      });
    }
    if (url.pathname === "/cookies") {
      const cookies = await getArenaCookies();
      return json(res, 200, { ok: true, cookies, cookieHeader: cookieHeader(cookies) });
    }
    if (url.pathname === "/cookies/save") {
      const result = await saveCookiesToEnv();
      return json(res, result.ok ? 200 : 401, result);
    }
    if (url.pathname === "/recaptcha") {
      const token = await recaptchaToken();
      return json(res, 200, { ok: true, token, generatedAt: lastRecaptchaAt });
    }
    if (url.pathname === "/open") {
      if (!page || page.isClosed()) page = await context.newPage();
      await page.goto(url.searchParams.get("url") || START_URL, { waitUntil: "domcontentloaded" });
      return json(res, 200, { ok: true, url: page.url() });
    }
    return json(res, 404, agentError("not_found", `Unknown path: ${url.pathname}`, ["Use /status, /cookies/save, /cookies, /recaptcha, or /open."]));
  } catch (err) {
    return json(res, 500, agentError("arena_session_error", err.message, [
      "Make sure the Playwright browser window is still open.",
      "If login is incomplete, finish login and call /cookies/save.",
      "If reCAPTCHA fails, reload /open and retry /recaptcha.",
    ]));
  }
}).listen(PORT, () => {
  log(`serviço iniciado em http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", async () => {
  await context?.close().catch(() => {});
  process.exit(0);
});

startBrowser().catch((err) => {
  console.error(`[arena-session] falha ao iniciar: ${err.message}`);
  process.exitCode = 1;
});
