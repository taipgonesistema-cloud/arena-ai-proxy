const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.ARENA_SESSION_PORT || 9230);
const START_URL = process.env.ARENA_LOGIN_URL || "https://arena.ai/text/direct";
const PROFILE_DIR = process.env.ARENA_PROFILE_DIR || path.join(__dirname, ".playwright-arena-profile");
const BROWSER_CHANNEL = process.env.ARENA_BROWSER_CHANNEL || "chrome";
const ENV_PATH = path.join(__dirname, ".env");
const ACCOUNTS_PATH = path.join(__dirname, "accounts.json");
const SITE_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
const LOGIN_ONLY = process.argv.includes("--login-only") || process.env.ARENA_LOGIN_ONLY === "1";

let browser = null;
let defaultContext = null;
let defaultPage = null;
let lastCookieSavedAt = 0;
let lastRecaptchaAt = 0;
let browserStartedAt = 0;
let server = null;

const accounts = new Map();

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

function loadAccountsConfig() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return [];
  try {
    const raw = fs.readFileSync(ACCOUNTS_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    log(`erro ao ler accounts.json: ${err.message}`);
    return [];
  }
}

function accountsStatus() {
  const list = [];
  for (const [email, state] of accounts) {
    const now = Date.now();
    const rateLimited = state.rateLimitedUntil > now;
    list.push({
      email,
      loggedIn: !!state.loggedIn,
      rateLimited,
      rateLimitedUntil: state.rateLimitedUntil,
      cookieCount: (state.cookies || []).length,
      hasArenaAuth: (state.cookies || []).some((c) => c.name === "arena-auth-prod-v1.0"),
    });
  }
  return list;
}

async function getAllCookies(ctx) {
  if (!ctx) return [];
  try { return await ctx.cookies(); }
  catch { return []; }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

async function loginArenaAccount(ctx, email, password) {
  const page = ctx.pages()[0] || await ctx.newPage();
  log(`fazendo login: ${email}`);
  await page.goto("https://arena.ai/auth/login", { waitUntil: "networkidle", timeout: 60000 }).catch(() =>
    page.goto("https://arena.ai/login", { waitUntil: "networkidle", timeout: 60000 }).catch(() =>
      page.goto("https://arena.ai/text/direct", { waitUntil: "domcontentloaded", timeout: 60000 })
    )
  );

  await page.waitForTimeout(2000);

  const emailField = await page.$('input[type="email"], input[name="email"], input[autocomplete="email"]').catch(() => null);
  if (emailField) {
    await emailField.fill(email);
    await page.waitForTimeout(500);

    const passField = await page.$('input[type="password"], input[name="password"]').catch(() => null);
    if (passField) {
      await passField.fill(password);
      await page.waitForTimeout(500);

      const submitBtn = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Entrar"), button:has-text("Continue")').catch(() => null);
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForTimeout(3000);
      }
    }
  }

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const cookies = await getAllCookies(ctx);
    if (cookies.some((c) => c.name === "arena-auth-prod-v1.0")) {
      const state = accounts.get(email) || {};
      state.cookies = cookies;
      state.loggedIn = true;
      state.rateLimitedUntil = 0;
      state.contextId = email;
      accounts.set(email, state);
      log(`login OK: ${email} (${cookies.length} cookies)`);
      return { ok: true, email, cookies: cookies.length };
    }
    const currentUrl = page.url();
    if (currentUrl.includes("text/direct") || currentUrl.includes("arena.ai/app")) {
      const cookies = await getAllCookies(ctx);
      if (cookies.some((c) => c.name === "arena-auth-prod-v1.0")) {
        const state = accounts.get(email) || {};
        state.cookies = cookies;
        state.loggedIn = true;
        state.rateLimitedUntil = 0;
        accounts.set(email, state);
        log(`login OK (redirect detectado): ${email} (${cookies.length} cookies)`);
        return { ok: true, email, cookies: cookies.length };
      }
    }
    if (i === 15) {
      log(`login pode precisar de interação manual: ${email}`);
    }
  }

  log(`login FALHOU para ${email} após 60s`);
  return { ok: false, email, error: "Login timeout - pode precisar de verificação manual (2FA/CAPTCHA)" };
}

async function loginAllAccounts() {
  if (!browser) return { ok: false, error: "Browser not started" };
  const config = loadAccountsConfig();
  if (config.length === 0) return { ok: false, error: "accounts.json vazio ou não encontrado" };

  const results = [];
  for (const { email, password } of config) {
    const existing = accounts.get(email);
    if (existing?.loggedIn && existing.rateLimitedUntil <= Date.now()) {
      const cookies = existing.cookies || [];
      if (cookies.some((c) => c.name === "arena-auth-prod-v1.0")) {
        results.push({ email, ok: true, skipped: true });
        continue;
      }
    }

    const ctx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
    });
    let result;
    try {
      result = await loginArenaAccount(ctx, email, password);
    } catch (err) {
      result = { email, ok: false, error: err.message };
    }
    results.push(result);
    if (result?.ok) {
      try { await ctx.close(); } catch {}
    }
  }
  return { ok: true, results };
}

async function loginSingleAccount(email, password) {
  if (!browser) return { ok: false, error: "Browser not started" };
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  try {
    const result = await loginArenaAccount(ctx, email, password);
    return result;
  } catch (err) {
    return { ok: false, email, error: err.message };
  }
}

function getNextAvailableAccount() {
  const now = Date.now();
  const available = [];
  for (const [email, state] of accounts) {
    if (state.loggedIn && state.rateLimitedUntil <= now) {
      available.push({ email, state });
    }
  }
  if (available.length === 0) return null;

  const sorted = available.sort((a, b) => (a.state.lastUsedAt || 0) - (b.state.lastUsedAt || 0));
  const chosen = sorted[0];
  chosen.state.lastUsedAt = now;

  const cookies = chosen.state.cookies || [];
  return {
    email: chosen.email,
    cookieHeader: cookieHeader(cookies),
    cookieCount: cookies.length,
    hasArenaAuth: cookies.some((c) => c.name === "arena-auth-prod-v1.0"),
  };
}

async function createDefaultContext() {
  if (!browser) return;
  if (!defaultContext) {
    defaultContext = await browser.newContext({
      viewport: { width: 1366, height: 900 },
    });
    defaultPage = defaultContext.pages()[0] || await defaultContext.newPage();
    defaultPage.on("close", () => {
      const existing = defaultContext.pages().find((candidate) => !candidate.isClosed());
      if (existing) { defaultPage = existing; return; }
      defaultPage = null;
    });
    await defaultPage.goto(START_URL, { waitUntil: "domcontentloaded" });
    log(`página principal: ${START_URL}`);
  }
}

async function recaptchaToken() {
  if (!defaultPage || defaultPage.isClosed()) throw new Error("Arena page is not open");
  await defaultPage.waitForFunction(() => window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute, null, { timeout: 30000 });
  const token = await defaultPage.evaluate((siteKey) => {
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
    browser = await playwright.chromium.launch(launchOptions);
  } catch (err) {
    log(`falha ao abrir channel=${BROWSER_CHANNEL}: ${err.message}`);
    log("usando Chromium embutido como fallback");
    const { channel, ...fallbackOptions } = launchOptions;
    browser = await playwright.chromium.launch(fallbackOptions);
  }

  browserStartedAt = Date.now();
  await createDefaultContext();

  const config = loadAccountsConfig();
  if (config.length > 0) {
    log(`${config.length} conta(s) encontrada(s) em accounts.json`);
    if (!LOGIN_ONLY) {
      loginAllAccounts().then((r) => {
        const ok = (r.results || []).filter((x) => x.ok).length;
        const fail = (r.results || []).filter((x) => !x.ok).length;
        log(`login automático: ${ok} ok, ${fail} falha`);
      }).catch((err) => log(`login automático: ${err.message}`));
    }
  } else {
    log("nenhuma accounts.json; modo legacy com .env");
  }

  if (LOGIN_ONLY) {
    if (config.length > 0) {
      await loginAllAccounts();
    } else {
      log("modo login legado: faça login na janela aberta");
    }
    await browser.close().catch(() => {});
    server?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  } else {
    log("sessão Playwright pronta");
  }
}

server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    if (pathname === "/status") {
      const cookies = defaultContext ? await getAllCookies(defaultContext).catch(() => []) : [];
      return json(res, 200, {
        ok: true,
        startedAt: browserStartedAt,
        url: defaultPage?.url?.() || null,
        pageOpen: !!defaultPage && !defaultPage.isClosed(),
        cookieCount: cookies.length,
        hasArenaAuth: cookies.some((cookie) => cookie.name === "arena-auth-prod-v1.0"),
        lastCookieSavedAt,
        lastRecaptchaAt,
        env: ENV_PATH,
        accounts: accountsStatus(),
        accountCount: accounts.size,
      });
    }

    if (pathname === "/cookies") {
      const cookies = defaultContext ? await getAllCookies(defaultContext).catch(() => []) : [];
      return json(res, 200, { ok: true, cookies, cookieHeader: cookieHeader(cookies) });
    }

    if (pathname === "/cookies/save") {
      const cookies = defaultContext ? await getAllCookies(defaultContext).catch(() => []) : [];
      const header = cookieHeader(cookies);
      if (!header.includes("arena-auth-prod-v1.0")) {
        return json(res, 401, agentError("arena_login_missing", "Arena auth cookie not found", [], { cookieCount: cookies.length }));
      }
      upsertEnv({ ARENA_COOKIE: header, ARENA_SESSION_URL: `http://127.0.0.1:${PORT}` });
      process.env.ARENA_COOKIE = header;
      lastCookieSavedAt = Date.now();
      log(`cookies salvos no .env (${cookies.length} cookies)`);
      return json(res, 200, { ok: true, cookieCount: cookies.length, headerLength: header.length });
    }

    if (pathname === "/recaptcha") {
      const token = await recaptchaToken();
      return json(res, 200, { ok: true, token, generatedAt: lastRecaptchaAt });
    }

    if (pathname === "/open") {
      if (!defaultContext) {
        await createDefaultContext();
      }
      if (!defaultPage || defaultPage.isClosed()) {
        defaultPage = await defaultContext.newPage();
      }
      await defaultPage.goto(url.searchParams.get("url") || START_URL, { waitUntil: "domcontentloaded" });
      return json(res, 200, { ok: true, url: defaultPage.url() });
    }

    if (pathname === "/accounts") {
      return json(res, 200, { ok: true, accounts: accountsStatus() });
    }

    if (pathname === "/accounts/login-all") {
      const result = await loginAllAccounts();
      return json(res, 200, result);
    }

    if (pathname === "/accounts/login" && req.method === "POST") {
      const body = await parseBody(req);
      const { email, password } = body;
      if (!email || !password) return json(res, 400, { ok: false, error: "email and password required" });
      const result = await loginSingleAccount(email, password);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (pathname === "/accounts/next") {
      const account = getNextAvailableAccount();
      if (!account) return json(res, 503, { ok: false, error: "No available accounts", accounts: accountsStatus() });
      return json(res, 200, { ok: true, ...account });
    }

    if (pathname === "/accounts/rate-limit" && req.method === "POST") {
      const body = await parseBody(req);
      const { email, cooldownMs } = body;
      if (!email) return json(res, 400, { ok: false, error: "email required" });
      const state = accounts.get(email);
      if (state) {
        const cooldown = Math.min(cooldownMs || 60000, 300000);
        state.rateLimitedUntil = Date.now() + cooldown;
        log(`conta rate-limited: ${email} (cooldown ${cooldown}ms)`);
      }
      return json(res, 200, { ok: true, email, rateLimited: true });
    }

    return json(res, 404, agentError("not_found", `Unknown path: ${pathname}`, ["Use /status, /cookies, /recaptcha, /accounts, /accounts/next, etc."]));
  } catch (err) {
    return json(res, 500, agentError("arena_session_error", err.message));
  }
}).listen(PORT, () => {
  log(`serviço iniciado em http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", async () => {
  await browser?.close().catch(() => {});
  process.exit(0);
});

startBrowser().catch((err) => {
  console.error(`[arena-session] falha ao iniciar: ${err.message}`);
  process.exitCode = 1;
});
