const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const PORT = Number(process.env.ARENA_SESSION_PORT || 9230);
const START_URL = process.env.ARENA_LOGIN_URL || "https://arena.ai/text/direct";
const BROWSER_CHANNEL = process.env.ARENA_BROWSER_CHANNEL || "chrome";
const ENV_PATH = path.join(__dirname, ".env");
const ACCOUNTS_PATH = path.join(__dirname, "accounts.json");
const SITE_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
const TOR_SOCKS_PORT = Number(process.env.TOR_SOCKS_PORT || 9050);
const TOR_CONTROL_PORT = Number(process.env.TOR_CONTROL_PORT || 9051);

let browser = null;
let defaultContext = null;
let defaultPage = null;
let lastRecaptchaAt = 0;
let browserStartedAt = 0;
let server = null;
let currentAccountId = null;
const accountRuntimes = new Map();
let globalRateLimitedUntil = 0;

// ─── Proxy Pool ──────────────────────────────────────────────────────
const proxyPool = [];
let proxyPoolIndex = 0;
const badProxyServers = new Set();

function parseProxyEntry(entry, defaultProtocol = "http") {
  try {
    const s = entry.trim();
    if (!s) return null;
    if (!s.includes("://")) {
      const [host, port] = s.split(":");
      if (host && port) return { server: `${defaultProtocol}://${host}:${port}`, protocol: defaultProtocol };
      return null;
    }
    const url = new URL(s);
    const proto = url.protocol.replace(":", "");
    const proxy = { server: `${proto}://${url.host}`, protocol: proto };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    return proxy;
  } catch {
    return null;
  }
}

function initProxyPoolFromEnv() {
  const envProxy = process.env.PROXY;
  const envList = process.env.PROXY_LIST;
  if (envList) {
    for (const s of envList.split(",")) {
      const p = parseProxyEntry(s);
      if (p) proxyPool.push(p);
    }
  }
  if (envProxy) {
    const p = parseProxyEntry(envProxy);
    if (p && !proxyPool.some(x => x.server === p.server)) proxyPool.push(p);
  }
  if (proxyPool.length > 0) log(`proxy pool: ${proxyPool.length} proxies (configurados via env)`);
  return proxyPool.length > 0;
}

function getNextProxy() {
  if (proxyPool.length === 0) return null;
  const start = proxyPoolIndex;
  for (let i = 0; i < proxyPool.length; i++) {
    const p = proxyPool[proxyPoolIndex % proxyPool.length];
    proxyPoolIndex++;
    if (!badProxyServers.has(p.server)) return p;
  }
  return null;
}

function markProxyBad(server) {
  if (server) {
    badProxyServers.add(server);
    log(`proxy marcado como ruim: ${server} (${badProxyServers.size}/${proxyPool.length} proxies ruins)`);
  }
}

function proxyPoolStatus() {
  return {
    total: proxyPool.length,
    bad: badProxyServers.size,
    good: proxyPool.length - badProxyServers.size,
    currentIndex: proxyPoolIndex,
  };
}

function checkTcpPort(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

function torControl(commands, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: TOR_CONTROL_PORT });
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Tor control timeout"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(commands.join("\r\n") + "\r\n"));
    socket.on("data", (chunk) => data += chunk);
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (/^5\d\d/m.test(data)) reject(new Error(data.trim() || "Tor control failed"));
      else resolve(data);
    });
  });
}

async function requestTorNewnym() {
  const response = await torControl(["AUTHENTICATE", "SIGNAL NEWNYM", "QUIT"]);
  badProxyServers.clear();
  for (const id of [...accountRuntimes.keys()]) await closeAccountRuntime(id);
  globalRateLimitedUntil = 0;
  return response;
}

function classifyArenaError(status, text) {
  const body = String(text || "");
  const tooManyRequests = status === 429 && /Too Many Requests/i.test(body);
  const promptFailed = status === 429 && /prompt failed/i.test(body);
  const rateLimit = status === 429 || /rate.?limit/i.test(body);
  const authExpired = status === 401 || /User not found/i.test(body);
  return { tooManyRequests, promptFailed, rateLimit, authExpired };
}

function isAuthCookie(name) {
  return name && !name.startsWith("cf_") && !name.startsWith("__cf") && !name.startsWith("_cf");
}

async function switchAccount(account) {
  if (currentAccountId === account.id && defaultPage && !defaultPage.isClosed()) return;
  log(`trocando conta: ${account.label} (cookies apenas, sem reload)`);
  if (defaultContext) {
    const valid = (account.cookies || []).filter(c => isAuthCookie(c.name) && c.value);
    if (valid.length > 0) await defaultContext.addCookies(valid).catch(() => {});
  }
  currentAccountId = account.id;
}

const accounts = new Map();

function validStoredCookies(cookies) {
  const nowSeconds = Date.now() / 1000;
  return (cookies || []).filter((cookie) => {
    if (!cookie?.name || !cookie?.value) return false;
    if (typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires < nowSeconds) return false;
    return true;
  });
}

async function closeAccountRuntime(id) {
  const runtime = accountRuntimes.get(id);
  if (!runtime) return;
  accountRuntimes.delete(id);
  await runtime.context?.close?.().catch(() => {});
}

async function getAccountRuntime(account) {
  const existing = accountRuntimes.get(account.id);
  if (existing?.page && !existing.page.isClosed()) return existing;
  if (existing) await closeAccountRuntime(account.id);

  const ctxOptions = { viewport: { width: 1280, height: 700 } };
  const proxy = getNextProxy();
  if (proxy) ctxOptions.proxy = proxy;
  const context = await browser.newContext(ctxOptions);
  const cookies = validStoredCookies(account.cookies || []);
  if (cookies.length > 0) await context.addCookies(cookies).catch(() => {});
  const page = await context.newPage();
  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (err) {
    // proxy lento ou morto, marca como ruim
    if (proxy) markProxyBad(proxy.server);
    await context.close().catch(() => {});
    throw new Error(`proxy failed for ${account.label}: ${err.message}`);
  }
  const runtime = { context, page, proxy };
  accountRuntimes.set(account.id, runtime);
  log(`runtime pronto para conta: ${account.label}${proxy ? ' via '+proxy.server : ''}`);
  return runtime;
}

async function getPageRecaptchaToken(page, label = "page") {
  await page.waitForFunction(
    () => window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute,
    null,
    { timeout: 30000 }
  );
  const token = await page.evaluate((siteKey) => {
    return window.grecaptcha.enterprise.execute(siteKey, { action: "chat_submit" });
  }, SITE_KEY);
  lastRecaptchaAt = Date.now();
  log(`reCAPTCHA ${label} gerado (${String(token || "").length} caracteres)`);
  return token;
}

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

function genId() {
  return "acc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function loadAccountsFromDisk() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
  } catch { return []; }
}

function saveAccountsToDisk() {
  const list = [];
  for (const [, state] of accounts) {
    list.push({
      id: state.id,
      label: state.label,
      cookies: state.cookies || [],
      createdAt: state.createdAt,
      lastUsedAt: state.lastUsedAt || 0,
      rateLimitedUntil: state.rateLimitedUntil || 0,
    });
  }
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(list, null, 2) + "\n");
  log(`accounts.json salvo (${list.length} contas)`);
}

function loadAccountsIntoMemory() {
  accounts.clear();
  const list = loadAccountsFromDisk();
  for (const acc of list) {
    accounts.set(acc.id, {
      id: acc.id,
      label: acc.label,
      cookies: acc.cookies || [],
      createdAt: acc.createdAt || Date.now(),
      lastUsedAt: acc.lastUsedAt || 0,
      rateLimitedUntil: acc.rateLimitedUntil || 0,
    });
  }
  log(`${accounts.size} conta(s) carregada(s) do accounts.json`);
}

function accountsStatus() {
  const now = Date.now();
  const list = [];
  for (const [, state] of accounts) {
    const cookies = state.cookies || [];
    list.push({
      id: state.id,
      label: state.label,
      cookieCount: cookies.length,
      hasArenaAuth: cookies.some((c) => c.name === "arena-auth-prod-v1.0"),
      rateLimited: state.rateLimitedUntil > now,
      rateLimitedUntil: state.rateLimitedUntil,
      lastUsedAt: state.lastUsedAt,
      createdAt: state.createdAt,
    });
  }
  return list;
}

function getNextAvailableAccount() {
  const now = Date.now();
  const available = [];
  for (const [, state] of accounts) {
    const cookies = state.cookies || [];
    if (cookies.some((c) => c.name === "arena-auth-prod-v1.0") && state.rateLimitedUntil <= now) {
      available.push(state);
    }
  }
  if (available.length === 0) return null;

  available.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  const chosen = available[0];
  chosen.lastUsedAt = now;

  return {
    id: chosen.id,
    label: chosen.label,
    cookies: chosen.cookies || [],
    cookieHeader: cookieHeader(chosen.cookies || []),
    cookieCount: (chosen.cookies || []).length,
    hasArenaAuth: (chosen.cookies || []).some((c) => c.name === "arena-auth-prod-v1.0"),
  };
}

async function getAllCookies(ctx) {
  if (!ctx) return [];
  try { return await ctx.cookies(); }
  catch { return []; }
}

async function getMainRecaptchaToken() {
  if (!defaultPage || defaultPage.isClosed()) throw new Error("Arena page is not open");
  return getPageRecaptchaToken(defaultPage, "principal");
}

async function createDefaultContext() {
  if (!browser) return;
  if (!defaultContext) {
    defaultContext = await browser.newContext({
      viewport: { width: 1280, height: 700 },
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

async function startBrowser() {
  loadDotEnv();
  let playwright;
  try {
    playwright = require("playwright");
  } catch (err) {
    console.error("[arena-session] playwright não encontrado; execute: npm install");
    throw err;
  }

  const launchOptions = {
    headless: false,
    channel: BROWSER_CHANNEL,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-default-browser-check",
      "--no-first-run",
      "--window-size=1280,800",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  try {
    browser = await playwright.chromium.launch(launchOptions);
  } catch (err) {
    log(`falha ao abrir channel=${BROWSER_CHANNEL}: ${err.message}; usando Chromium embutido`);
    const { channel, ...fallback } = launchOptions;
    browser = await playwright.chromium.launch(fallback);
  }

  browserStartedAt = Date.now();
  loadAccountsIntoMemory();
  initProxyPoolFromEnv();
  await createDefaultContext();
  // apply first available account's cookies so the page loads logged in
  const first = getNextAvailableAccount();
  if (first && defaultPage) {
    try {
      await defaultContext.addCookies(
        (accounts.get(first.id)?.cookies || []).filter(c => isAuthCookie(c.name) && c.value)
      );
      currentAccountId = first.id;
      await defaultPage.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      log(`cookies da conta "${first.label}" aplicados na página principal`);
    } catch (err) {
      log(`aviso: não foi possível aplicar cookies: ${err.message}`);
    }
  }
  log("sessão Playwright pronta");
}

server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    if (pathname === "/status") {
      return json(res, 200, {
        ok: true,
        startedAt: browserStartedAt,
        url: defaultPage?.url?.() || null,
        pageOpen: !!defaultPage && !defaultPage.isClosed(),
        globalRateLimited: globalRateLimitedUntil > Date.now(),
        globalRateLimitedUntil,
        proxy: proxyPoolStatus(),
        accounts: accountsStatus(),
        accountCount: accounts.size,
      });
    }

    if (pathname === "/health") {
      const accountsList = accountsStatus();
      const torSocks = await checkTcpPort(TOR_SOCKS_PORT);
      const torControlOpen = await checkTcpPort(TOR_CONTROL_PORT);
      const browserOk = !!browser;
      const pageOpen = !!defaultPage && !defaultPage.isClosed();
      const accountsAvailable = accountsList.filter((acc) => acc.hasArenaAuth && !acc.rateLimited).length;
      const checks = {
        browser: browserOk,
        pageOpen,
        torSocks,
        torControl: torControlOpen,
        accountsAvailable: accountsAvailable > 0,
      };
      return json(res, 200, {
        ok: Object.values(checks).every(Boolean),
        checks,
        startedAt: browserStartedAt,
        url: defaultPage?.url?.() || null,
        proxy: proxyPoolStatus(),
        globalRateLimited: globalRateLimitedUntil > Date.now(),
        globalRateLimitedUntil,
        accountCount: accounts.size,
        accountsAvailable,
      });
    }

    if (pathname === "/tor/newnym" && req.method === "POST") {
      try {
        const response = await requestTorNewnym();
        log("Tor NEWNYM solicitado; runtimes reiniciados");
        return json(res, 200, { ok: true, response });
      } catch (err) {
        return json(res, 503, { ok: false, error: err.message });
      }
    }

    if (pathname === "/cookies") {
      const cookies = defaultContext ? await getAllCookies(defaultContext).catch(() => []) : [];
      return json(res, 200, { ok: true, cookies, cookieHeader: cookieHeader(cookies) });
    }

    if (pathname === "/recaptcha") {
      const token = await getMainRecaptchaToken();
      return json(res, 200, { ok: true, token, generatedAt: lastRecaptchaAt });
    }

    if (pathname === "/open") {
      if (!defaultContext) await createDefaultContext();
      if (!defaultPage || defaultPage.isClosed()) defaultPage = await defaultContext.newPage();
      await defaultPage.goto(url.searchParams.get("url") || START_URL, { waitUntil: "domcontentloaded" });
      return json(res, 200, { ok: true, url: defaultPage.url() });
    }

    // ─── Account Management ─────────────────────────────────────────

    if (pathname === "/accounts") {
      return json(res, 200, { ok: true, accounts: accountsStatus() });
    }

    // POST /accounts/save  { id, label, cookies }
    if (pathname === "/accounts/save" && req.method === "POST") {
      const body = await parseBody(req);
      const id = body.id || genId();
      const label = body.label || `Conta ${accounts.size + 1}`;
      const cookies = Array.isArray(body.cookies) ? body.cookies : [];

      const existing = accounts.get(id);
      accounts.set(id, {
        id,
        label: body.label || existing?.label || label,
        cookies,
        createdAt: existing?.createdAt || Date.now(),
        lastUsedAt: existing?.lastUsedAt || 0,
        rateLimitedUntil: existing?.rateLimitedUntil || 0,
      });
      saveAccountsToDisk();
      await closeAccountRuntime(id);
      log(`conta salva: ${label} (${cookies.length} cookies)`);
      return json(res, 200, { ok: true, id, label, cookieCount: cookies.length });
    }

    // POST /accounts/login  { label? }
    // Opens a clean browser context with no cookies, navigates to Arena,
    // waits for the user to log in manually, then captures cookies.
    if (pathname === "/accounts/login" && req.method === "POST") {
      if (!browser) return json(res, 500, { ok: false, error: "Browser not started" });
      const body = await parseBody(req);
      const label = body.label || `Conta ${accounts.size + 1}`;

      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 700 },
      });
      const loginPage = ctx.pages()[0] || await ctx.newPage();
      await loginPage.goto("https://arena.ai/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() =>
        loginPage.goto("https://arena.ai/text/direct", { waitUntil: "domcontentloaded", timeout: 30000 })
      );
      log(`janela de login aberta para: ${label}`);
      log("faça login manualmente na janela aberta — digite algo no chat e pressione Enter");

      // Wait up to 10 minutes for manual login
      const id = genId();
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const cookies = await getAllCookies(ctx);
        if (cookies.some((c) => c.name === "arena-auth-prod-v1.0")) {
          accounts.set(id, {
            id,
            label,
            cookies,
            createdAt: Date.now(),
            lastUsedAt: 0,
            rateLimitedUntil: 0,
          });
          saveAccountsToDisk();
          await ctx.close().catch(() => {});
          log(`login OK: ${label} (${cookies.length} cookies)`);
          return json(res, 200, { ok: true, id, label, cookieCount: cookies.length });
        }
        if (i % 15 === 0) log(`aguardando login: ${label} (${Math.round(i * 2)}s)`);
      }

      await ctx.close().catch(() => {});
      log(`login cancelado/timeout: ${label}`);
      return json(res, 408, { ok: false, error: "Login timeout após 10 minutos" });
    }

    // POST /accounts/re-login  { id }
    // Opens a clean context specifically to re-login an existing account.
    if (pathname === "/accounts/re-login" && req.method === "POST") {
      if (!browser) return json(res, 500, { ok: false, error: "Browser not started" });
      const body = await parseBody(req);
      const existing = accounts.get(body.id);
      if (!existing) return json(res, 404, { ok: false, error: "Account not found" });

      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 700 },
      });
      const loginPage = ctx.pages()[0] || await ctx.newPage();
      await loginPage.goto("https://arena.ai/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() =>
        loginPage.goto("https://arena.ai/text/direct", { waitUntil: "domcontentloaded", timeout: 30000 })
      );
      log(`re-login: ${existing.label}`);

      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const cookies = await getAllCookies(ctx);
        if (cookies.some((c) => c.name === "arena-auth-prod-v1.0")) {
          existing.cookies = cookies;
          existing.rateLimitedUntil = 0;
          existing.lastUsedAt = 0;
          saveAccountsToDisk();
          await closeAccountRuntime(existing.id);
          await ctx.close().catch(() => {});
          log(`re-login OK: ${existing.label}`);
          return json(res, 200, { ok: true, id: existing.id, label: existing.label, cookieCount: cookies.length });
        }
      }

      await ctx.close().catch(() => {});
      return json(res, 408, { ok: false, error: "Re-login timeout" });
    }

    // POST /accounts/remove  { id }
    if (pathname === "/accounts/remove" && req.method === "POST") {
      const body = await parseBody(req);
      const removed = accounts.get(body.id);
      if (!removed) return json(res, 404, { ok: false, error: "Account not found" });
      accounts.delete(body.id);
      saveAccountsToDisk();
      await closeAccountRuntime(body.id);
      log(`conta removida: ${removed.label}`);
      return json(res, 200, { ok: true, id: body.id, label: removed.label });
    }

    // GET /accounts/next - returns next available account's cookies
    if (pathname === "/accounts/next") {
      const account = getNextAvailableAccount();
      if (!account) return json(res, 503, { ok: false, error: "No available accounts", accounts: accountsStatus() });
      return json(res, 200, { ok: true, ...account });
    }

    // POST /accounts/rate-limit  { id: string, cooldownMs?: number }
    if (pathname === "/accounts/rate-limit" && req.method === "POST") {
      const body = await parseBody(req);
      const id = body.id || body.email;
      if (!id) return json(res, 400, { ok: false, error: "account id required" });
      const state = accounts.get(id);
      if (state) {
        const cooldown = Math.min(body.cooldownMs || 60000, 300000);
        state.rateLimitedUntil = Date.now() + cooldown;
        log(`rate-limited: ${state.label} (cooldown ${cooldown}ms)`);
      }
      return json(res, 200, { ok: true, id, rateLimited: true });
    }

    // POST /arena/chat  { prompt, modelId }
    // Makes the Arena API call through the default page (bypasses Cloudflare).
    if (pathname === "/arena/chat" && req.method === "POST") {
      if (!browser) return json(res, 500, { ok: false, error: "Browser not started" });
      if (!defaultPage || defaultPage.isClosed()) {
        return json(res, 200, { ok: false, status: 503, text: "Page not open", accountId: null, accountLabel: null, is429: false });
      }

      const body = await parseBody(req);
      const { prompt, modelId, id, userMessageId, modelMessageId } = body;
      if (!prompt) return json(res, 400, { ok: false, error: "prompt required" });
      if (!modelId) return json(res, 400, { ok: false, error: "modelId required" });

      if (globalRateLimitedUntil > Date.now()) {
        return json(res, 200, {
          ok: false,
          status: 429,
          text: JSON.stringify({ error: "Too Many Requests", message: "Arena global cooldown active" }),
          accountId: null,
          accountLabel: null,
          is429: true,
          globalRateLimitedUntil,
        });
      }

      const maxAttempts = Math.max(1, accounts.size);
      let lastResult = null;
      let lastAccount = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const account = getNextAvailableAccount();
        if (!account) break;

        account.lastUsedAt = Date.now();
        saveAccountsToDisk();

        let runtime;
        try {
          runtime = await getAccountRuntime(account);
        } catch (err) {
          log(`arena/chat runtime failed for ${account.label}: ${err.message}`);
          continue; // proxy morto, tenta próxima conta
        }
        const page = runtime.page;

        // Generate a fresh reCAPTCHA token per account attempt from the same
        // page/context that will send the request. Tokens can be context-bound.
        let recaptchaToken = "";
        try {
          recaptchaToken = await getPageRecaptchaToken(page, account.label);
        } catch (e) {
          if (runtime.proxy) markProxyBad(runtime.proxy.server);
          log(`reCAPTCHA account page warn: ${e.message}`);
          try {
            await page.goto(START_URL, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
            recaptchaToken = await getPageRecaptchaToken(page, `${account.label}:reload`);
          } catch (fallbackErr) {
            log(`reCAPTCHA account page reload warn: ${fallbackErr.message}`);
            try {
              recaptchaToken = await getMainRecaptchaToken();
            } catch (mainErr) {
              log(`reCAPTCHA main page warn: ${mainErr.message}`);
            }
          }
        }

        // Make the API call inside the browser page (uses real browser fetch with Cloudflare clearance)
        const result = await page.evaluate(async ({ prompt, modelId, id, userMsgId, modelMsgId, recaptchaToken }) => {
          const response = await fetch("https://arena.ai/nextjs-api/stream/create-evaluation", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
            body: JSON.stringify({
              id, mode: "direct-battle", modelAId: modelId,
              userMessageId: userMsgId, modelAMessageId: modelMsgId,
              userMessage: { content: prompt, experimental_attachments: [], metadata: {} },
              modality: "chat", recaptchaV3Token: recaptchaToken,
            }),
          });
          const text = await response.text();
          return { status: response.status, text };
        }, {
          prompt, modelId,
          id: id || require("crypto").randomUUID(),
          userMsgId: userMessageId || require("crypto").randomUUID(),
          modelMsgId: modelMessageId || require("crypto").randomUUID(),
          recaptchaToken,
        });

        const classified = classifyArenaError(result.status, result.text);
        const is429 = classified.rateLimit;
        const is401 = classified.authExpired;
        log(`arena/chat attempt=${attempt}/${maxAttempts} account=${account.label} status=${result.status} bytes=${result.text.length}`);

        lastResult = { result, is429, is401, classified };
        lastAccount = account;

        if (!is429 && !is401) {
          return json(res, 200, {
            ok: result.status === 200,
            status: result.status,
            text: result.text,
            accountId: account.id,
            accountLabel: account.label,
            is429,
          });
        }

        // Mark proxy as bad and close runtime so next attempt gets a new proxy
        const currentRuntime = accountRuntimes.get(account.id);
        if (currentRuntime?.proxy?.server) markProxyBad(currentRuntime.proxy.server);
        await closeAccountRuntime(account.id);

        if (classified.tooManyRequests && !classified.promptFailed) {
          const remainingGood = proxyPool.length - badProxyServers.size;
          if (remainingGood > 0 && attempt < maxAttempts) {
            log(`arena/chat proxy rotation: ${account.label} 429, ${remainingGood} proxies bons restantes`);
          } else {
            globalRateLimitedUntil = Date.now() + 60000;
            log(`arena/chat sem mais proxies, global cooldown 60s`);
            break;
          }
        }

        const state = accounts.get(account.id);
        if (state) state.rateLimitedUntil = Date.now() + (is401 ? 0 : 60000);
        if (is401) await closeAccountRuntime(account.id);
        saveAccountsToDisk();
        log(`arena/chat switching after ${result.status} on ${account.label}`);
      }

      return json(res, 200, {
        ok: false,
        status: lastResult?.result?.status || 503,
        text: lastResult?.result?.text || "No available accounts",
        accountId: lastAccount?.id || null,
        accountLabel: lastAccount?.label || null,
        is429: !!lastResult?.is429,
      });
    }

    return json(res, 404, agentError("not_found", `Unknown path: ${pathname}`));
  } catch (err) {
    log(`erro: ${err.message}`);
    return json(res, 500, agentError("arena_session_error", err.message));
  }
}).listen(PORT, () => {
  log(`serviço iniciado em http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", async () => {
  for (const id of [...accountRuntimes.keys()]) await closeAccountRuntime(id);
  await browser?.close().catch(() => {});
  process.exit(0);
});

startBrowser().catch((err) => {
  console.error(`[arena-session] falha ao iniciar: ${err.message}`);
  process.exitCode = 1;
});
