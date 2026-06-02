#!/usr/bin/env node
/**
 * Arena AI Proxy — One-Click Launcher v3
 *
 * - Reads .env to discover real PORT
 * - Account management before proxy start
 * - Port conflict detection + kill
 * - Auto-configures Pi.dev models.json with correct port
 * - Clean status display (no log spam)
 */

const { spawn, execSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// ── SEA detection ──────────────────────────────────────
const isSEA = (() => {
  try { require("node:sea"); return require("node:sea").isSea(); } catch { return false; }
})();

function resolveProjectRoot(startDir) {
  const candidates = [startDir, path.dirname(startDir)];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "package.json")) &&
      fs.existsSync(path.join(candidate, "start.cjs")) &&
      fs.existsSync(path.join(candidate, "arena-proxy.js"))
    ) {
      return candidate;
    }
  }
  return startDir;
}

const APP_DIR = isSEA ? path.dirname(process.execPath) : __dirname;
const ROOT = resolveProjectRoot(APP_DIR);

function findNodeExe() {
  if (!isSEA) return process.execPath;
  try {
    const where = execSync("where.exe node", { encoding: "utf8", stdio: "pipe" }).trim();
    for (const line of where.split(/\r?\n/)) {
      const p = line.trim();
      if (p && p !== process.execPath && fs.existsSync(p)) return p;
    }
  } catch {}
  const pf = path.join(process.env.ProgramFiles || "", "nodejs", "node.exe");
  if (fs.existsSync(pf)) return pf;
  return "node";
}

const NODE_EXE = findNodeExe();

// ── Load .env (same logic as arena-proxy.js) ───────────
const ENV_PATH = path.join(ROOT, ".env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Paths ──────────────────────────────────────────────
const NODE_MODULES = path.join(ROOT, "node_modules");
const TOR_EXE = path.join(ROOT, "tor", "tor-real.exe");
const ACCOUNTS_FILE = path.join(ROOT, "accounts.json");

const PI_DIR = path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const PI_MODELS = path.join(PI_DIR, "models.json");
const PI_SETTINGS = path.join(PI_DIR, "settings.json");

// ── Config (after .env loaded) ─────────────────────────
const PROXY_PORT = Number(process.env.PORT || 9228);
const SESSION_PORT = Number(process.env.ARENA_SESSION_PORT || 9230);
const TOR_PORT = 9050;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;

// ── ANSI ───────────────────────────────────────────────
const R = "\x1b[0m";
const GREEN   = (s) => `\x1b[32m${s}${R}`;
const YELLOW  = (s) => `\x1b[33m${s}${R}`;
const RED     = (s) => `\x1b[31m${s}${R}`;
const CYAN    = (s) => `\x1b[36m${s}${R}`;
const BOLD    = (s) => `\x1b[1m${s}${R}`;
const DIM     = (s) => `\x1b[2m${s}${R}`;
const CLEAR_LINE  = "\x1b[2K\r";
const SHOW_CURSOR = "\x1b[?25h";

// ── Logging ────────────────────────────────────────────
function banner() {
  console.log("");
  console.log(BOLD(CYAN("  ╔══════════════════════════════════════════╗")));
  console.log(BOLD(CYAN("  ║       Arena AI Proxy  —  Launcher       ║")));
  console.log(BOLD(CYAN("  ╚══════════════════════════════════════════╝")));
  console.log("");
}

function step(n, msg)  { console.log(`  ${CYAN(`[${n}]`)} ${msg}`); }
function ok(msg)       { console.log(`      ${GREEN("+")} ${msg}`); }
function warn(msg)     { console.log(`      ${YELLOW("!")} ${msg}`); }
function fail(msg)     { console.log(`      ${RED("x")} ${msg}`); }
function info(msg)     { console.log(`      ${DIM(msg)}`); }
function gap()         { console.log(""); }

// ── Utils ──────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });
}

function getPidOnPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr ":${port} "`, {
      encoding: "utf8", stdio: "pipe", timeout: 5000,
    });
    for (const line of out.trim().split(/\r?\n/)) {
      if (line.includes("LISTENING")) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid > 0) return pid;
      }
    }
  } catch {}
  return null;
}

function getProcessName(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: "utf8", stdio: "pipe", timeout: 5000,
    }).trim();
    const match = out.match(/"([^"]+)"/);
    return match ? match[1] : `PID ${pid}`;
  } catch {
    return `PID ${pid}`;
  }
}

function killPid(pid) {
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Port check ─────────────────────────────────────────
async function checkPort(port, label) {
  const open = await isPortOpen(port);
  if (!open) return true;

  const pid = getPidOnPort(port);
  if (!pid) {
    warn(`Port ${port} (${label}) busy — PID unknown`);
    return false;
  }

  const procName = getProcessName(pid);
  warn(`Port ${port} (${label}) in use by ${BOLD(procName)} (PID ${pid})`);

  const answer = await ask(`      Kill ${procName} to free port ${port}? ${DIM("[Y/n]")} `);
  if (answer === "" || answer === "y" || answer === "yes") {
    if (killPid(pid)) {
      ok(`Killed ${procName} (PID ${pid})`);
      await sleep(500);
      return true;
    } else {
      fail(`Failed to kill PID ${pid}`);
      return false;
    }
  }
  return false;
}

// ── Get local accounts info ────────────────────────────
function getLocalAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (!Array.isArray(list)) return [];
    return list.map((a) => ({
      id: a.id || "?",
      label: a.label || a.id || "?",
      hasCookies: Array.isArray(a.cookies) && a.cookies.length > 0,
      hasAuth: Array.isArray(a.cookies) && a.cookies.some((c) => c.name === "arena-auth-prod-v1.0"),
      rateLimited: (a.rateLimitedUntil || 0) > Date.now(),
    }));
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════
//  STEPS
// ════════════════════════════════════════════════════════

// ── 1. Dependencies ────────────────────────────────────
function stepDeps() {
  step(1, "Dependencies");

  if (!fs.existsSync(NODE_MODULES)) {
    warn("node_modules missing — running npm install ...");
    try {
      execSync("npm install", { cwd: ROOT, stdio: "inherit" });
      ok("npm install done");
    } catch {
      fail("npm install failed");
      process.exit(1);
    }
  } else {
    ok("node_modules");
  }

  try {
    const pwDir = path.join(NODE_MODULES, "playwright");
    if (fs.existsSync(pwDir)) {
      const check = execSync("npx playwright install chromium --dry-run 2>&1", {
        cwd: ROOT, encoding: "utf8", timeout: 15000,
      });
      if (check.includes("not installed")) {
        warn("Installing Playwright browsers ...");
        execSync("npx playwright install chromium", { cwd: ROOT, stdio: "inherit" });
        ok("Playwright browsers installed");
      } else {
        ok("Playwright browsers");
      }
    }
  } catch {
    ok("Playwright (browser check skipped)");
  }

  if (fs.existsSync(TOR_EXE)) {
    ok("Tor binary");
  } else {
    warn("Tor not found — runs without anonymization");
  }
}

// ── 2. Accounts ────────────────────────────────────────
async function stepAccounts() {
  step(2, "Accounts");

  const accounts = getLocalAccounts();

  if (accounts.length === 0) {
    warn("No accounts configured");
    info("You need at least one Arena account to use the proxy.");
    gap();

    const answer = await ask(`      Open account manager now? ${DIM("[Y/n]")} `);
    if (answer === "" || answer === "y" || answer === "yes") {
      await runAccountManager();
      // Re-check after manager exits
      const after = getLocalAccounts();
      if (after.length === 0) {
        fail("Still no accounts. Proxy won't work without one.");
        const cont = await ask(`      Continue anyway? ${DIM("[y/N]")} `);
        if (cont !== "y" && cont !== "yes") {
          process.exit(1);
        }
      } else {
        ok(`${after.length} account(s) ready`);
      }
    } else {
      warn("Skipped — proxy may fail without accounts");
    }
    return;
  }

  // Show existing accounts
  const valid = accounts.filter((a) => a.hasCookies);
  const noAuth = accounts.filter((a) => !a.hasAuth);
  const limited = accounts.filter((a) => a.rateLimited);

  let summary = `${valid.length} account(s)`;
  if (limited.length > 0) summary += `  ${YELLOW(`(${limited.length} rate-limited)`)}`;
  if (noAuth.length > 0) summary += `  ${RED(`(${noAuth.length} expired)`)}`;
  ok(summary);

  for (const acc of accounts) {
    let status = GREEN("ok");
    if (acc.rateLimited) status = YELLOW("rate-limited");
    else if (!acc.hasAuth) status = RED("expired");
    else if (!acc.hasCookies) status = RED("no cookies");
    info(`${acc.label}  ${status}`);
  }

  gap();
  const answer = await ask(`      Manage accounts? (add/remove/re-login) ${DIM("[y/N]")} `);
  if (answer === "y" || answer === "yes") {
    await runAccountManager();
  }
}

async function runAccountManager() {
  info("Starting account manager ...");
  info("(This needs the session service — starting it temporarily)");
  gap();

  // Start session service temporarily for the account manager
  const sessionChild = spawn(NODE_EXE, ["arena-session.cjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: false,
  });

  // Wait for session to be ready
  const deadline = Date.now() + 90000;
  let sessionReady = false;
  while (Date.now() < deadline) {
    try {
      const status = await httpGet(`http://127.0.0.1:${SESSION_PORT}/status`, 3000);
      if (status && status.ok) {
        sessionReady = true;
        break;
      }
    } catch {}
    await sleep(2000);
  }

  if (!sessionReady) {
    warn("Session service did not start — cannot manage accounts right now");
    if (!sessionChild.killed) sessionChild.kill();
    return;
  }

  ok("Session service ready");
  gap();

  // Run the account manager TUI (interactive, inherits stdio)
  await new Promise((resolve) => {
    const mgr = spawn(NODE_EXE, ["arena-accounts.js"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env },
    });
    mgr.on("exit", resolve);
  });

  // Kill the temporary session service
  if (!sessionChild.killed) sessionChild.kill();
  gap();
  ok("Account manager closed");
}

// ── 3. Ports ───────────────────────────────────────────
async function stepPorts() {
  step(3, "Ports");

  const hasTor = fs.existsSync(TOR_EXE);
  const ports = [
    { port: PROXY_PORT, label: "Proxy" },
    { port: SESSION_PORT, label: "Session" },
  ];
  if (hasTor) ports.push({ port: TOR_PORT, label: "Tor" });

  let allFree = true;
  for (const { port, label } of ports) {
    const free = await checkPort(port, label);
    if (free) {
      ok(`${port} (${label}) free`);
    } else {
      allFree = false;
    }
  }

  if (!allFree) {
    const answer = await ask(`      Ports busy. Continue anyway? ${DIM("[y/N]")} `);
    if (answer !== "y" && answer !== "yes") {
      console.log(DIM("  Aborted."));
      process.exit(1);
    }
  }
}

// ── 4. Pi.dev config ───────────────────────────────────
function stepPiConfig() {
  step(4, "Pi.dev CLI config");

  const modelsConfig = {
    providers: {
      "arena-proxy": {
        baseUrl: `${PROXY_URL}/v1`,
        api: "openai-completions",
        apiKey: "dummy",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [{ id: "arena-default" }],
      },
    },
  };

  if (!fs.existsSync(PI_DIR)) {
    fs.mkdirSync(PI_DIR, { recursive: true });
  }

  // Merge models.json
  let existing = {};
  if (fs.existsSync(PI_MODELS)) {
    try { existing = JSON.parse(fs.readFileSync(PI_MODELS, "utf8")); } catch {}
  }
  const merged = {
    ...existing,
    providers: { ...(existing.providers || {}), ...modelsConfig.providers },
  };
  fs.writeFileSync(PI_MODELS, JSON.stringify(merged, null, 2), "utf8");
  ok("models.json updated");

  // Merge settings.json
  let existingSettings = {};
  if (fs.existsSync(PI_SETTINGS)) {
    try { existingSettings = JSON.parse(fs.readFileSync(PI_SETTINGS, "utf8")); } catch {}
  }
  fs.writeFileSync(PI_SETTINGS, JSON.stringify({
    ...existingSettings,
    defaultProvider: "arena-proxy",
    defaultModel: "arena-default",
  }, null, 2), "utf8");
  ok("settings.json updated");

  info(`baseUrl = ${PROXY_URL}/v1`);
  if (fs.existsSync(ENV_PATH)) {
    info(`PORT read from .env = ${PROXY_PORT}`);
  } else {
    info(`PORT = ${PROXY_PORT} (default)`);
  }
}

// ── 5. Start stack (quiet) ─────────────────────────────
function stepStartStack() {
  return new Promise((resolve) => {
    step(5, "Starting services");
    gap();

    const serviceStatus = {
      tor: DIM("waiting"),
      session: DIM("waiting"),
      proxy: DIM("waiting"),
    };
    const hasTor = fs.existsSync(TOR_EXE);
    if (!hasTor) serviceStatus.tor = DIM("skip");

    let resolved = false;
    let lastError = "";

    function drawStatus() {
      return [
        `  ${DIM("|")}  Tor:     ${serviceStatus.tor}`,
        `  ${DIM("|")}  Session: ${serviceStatus.session}`,
        `  ${DIM("|")}  Proxy:   ${serviceStatus.proxy}`,
      ].join("\n");
    }

    let statusLines = 0;
    function render() {
      if (resolved) return;
      if (statusLines > 0) {
        process.stdout.write(`\x1b[${statusLines}A`);
        for (let i = 0; i < statusLines; i++) {
          process.stdout.write(CLEAR_LINE + "\n");
        }
        process.stdout.write(`\x1b[${statusLines}A`);
      }
      const block = drawStatus();
      process.stdout.write(block + "\n");
      statusLines = block.split("\n").length;
    }

    render();

    const child = spawn(NODE_EXE, ["start.cjs"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      windowsHide: false,
    });

    let outputBuffer = "";

    function processLine(line) {
      if (resolved) return;
      const lower = line.toLowerCase();

      // Tor
      if (lower.includes("[tor]") || lower.includes("tor pronto") || lower.includes("bootstrapped 100%")) {
        if (lower.includes("100%") || lower.includes("pronto") || lower.includes("ready")) {
          serviceStatus.tor = GREEN("ready");
        } else if (lower.includes("iniciado") || lower.includes("bootstrap")) {
          serviceStatus.tor = YELLOW("starting");
        } else if (lower.includes("error") || lower.includes("failed")) {
          serviceStatus.tor = RED("error");
          lastError = line.trim();
        }
        render();
        return;
      }

      // Session
      if (lower.includes("[session]") || lower.includes("session")) {
        if (lower.includes("ready") || lower.includes("pronta") || lower.includes("listening")) {
          serviceStatus.session = GREEN("ready");
        } else if (lower.includes("error") || lower.includes("failed")) {
          serviceStatus.session = RED("error");
          lastError = line.trim();
        } else if (lower.includes("start") || lower.includes("launch") || lower.includes("navig") || lower.includes("browser")) {
          serviceStatus.session = YELLOW("starting");
        }
        render();
        return;
      }

      // Proxy
      if (lower.includes("[proxy]") || lower.includes("proxy")) {
        if (lower.includes("listening") || lower.includes("ready") || lower.includes("running on")) {
          serviceStatus.proxy = GREEN("ready");
        } else if (lower.includes("error") || lower.includes("failed")) {
          serviceStatus.proxy = RED("error");
          lastError = line.trim();
        } else if (lower.includes("start") || lower.includes("iniciando")) {
          serviceStatus.proxy = YELLOW("starting");
        }
        render();
        return;
      }

      // Start orchestrator
      if (lower.includes("[start]")) {
        if (lower.includes("tor pronto") || lower.includes("tor ready")) {
          serviceStatus.tor = GREEN("ready");
        }
        if (lower.includes("session ready") || lower.includes("pronta")) {
          serviceStatus.session = GREEN("ready");
        }
        if (lower.includes("proxy iniciando") || lower.includes("proxy start")) {
          serviceStatus.proxy = YELLOW("starting");
        }
        render();
      }
    }

    function onData(chunk) {
      if (resolved) return;
      outputBuffer += chunk.toString();
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) processLine(line);
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("exit", (code) => {
      if (code !== 0 && code !== null && !resolved) {
        serviceStatus.proxy = RED("crashed");
        serviceStatus.session = RED("crashed");
        render();
        gap();
        if (lastError) fail(lastError);
        fail(`Stack exited with code ${code}`);
      }
    });

    // Poll for proxy readiness
    const deadline = Date.now() + 180000;
    const poll = async () => {
      while (Date.now() < deadline) {
        try {
          const res = await httpGet(`${PROXY_URL}/v1/models`, 3000);
          if (res && (res.data || res.object)) {
            serviceStatus.proxy = GREEN("ready");
            render();
            gap();
            resolved = true;
            resolve({ child, models: res, lastError });
            return;
          }
        } catch {}
        await sleep(2000);
      }
      gap();
      resolved = true;
      resolve({ child, models: null, lastError });
    };
    poll();
  });
}

// ── 6. Summary ─────────────────────────────────────────
function stepSummary(models) {
  step(6, "Status");

  if (models && models.data && Array.isArray(models.data)) {
    ok(`Proxy online — ${models.data.length} models`);
    info(`Endpoint: ${PROXY_URL}/v1`);

    const sample = models.data.slice(0, 4).map((m) => m.id).join(DIM(", "));
    info(`Models: ${sample} ...`);
  } else {
    warn("Proxy started but no model response yet");
    info(`Check: ${PROXY_URL}/v1/models`);
  }
}

// ── 7. Launch Pi ───────────────────────────────────────
async function stepLaunchPi() {
  let hasPi = false;
  try {
    execSync("where.exe pi", { encoding: "utf8", stdio: "pipe" });
    hasPi = true;
  } catch {}

  if (!hasPi) {
    info("Pi CLI not in PATH — start it manually when needed");
    return false;
  }

  gap();
  console.log(BOLD(GREEN("  ═══════════════════════════════════════════")));
  console.log(BOLD(GREEN("  Ready.")));
  console.log(BOLD(GREEN("  ═══════════════════════════════════════════")));
  gap();

  const answer = await ask(`  Launch Pi CLI? ${DIM("[Y/n]")} `);

  if (answer === "" || answer === "y" || answer === "yes") {
    gap();
    console.log(`  ${DIM("─── Pi.dev ───────────────────────────────")}`);
    gap();

    const pi = spawn("pi", [], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env },
    });

    pi.on("exit", (code) => {
      gap();
      console.log(DIM(`  Pi exited (${code})`));
      process.exit(0);
    });

    return new Promise(() => {});
  }
  return false;
}

// ── Main ───────────────────────────────────────────────
let proxyChild = null;

function cleanup() {
  process.stdout.write(SHOW_CURSOR);
  if (proxyChild && !proxyChild.killed) {
    proxyChild.kill();
  }
}

process.on("SIGINT", () => {
  gap();
  console.log(DIM("  Shutting down ..."));
  cleanup();
  setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
  cleanup();
  setTimeout(() => process.exit(0), 1000);
});

(async () => {
  banner();

  // 1. Deps
  stepDeps();
  gap();

  // 2. Accounts (before proxy — manage first)
  await stepAccounts();
  gap();

  // 3. Ports
  await stepPorts();
  gap();

  // 4. Pi.dev config (uses correct PORT)
  stepPiConfig();
  gap();

  // 5. Start stack
  const { child, models } = await stepStartStack();
  proxyChild = child;

  // 6. Summary
  stepSummary(models);
  gap();

  // 7. Launch Pi
  const launched = await stepLaunchPi();

  if (!launched) {
    gap();
    console.log(DIM("  Proxy running. Ctrl+C to stop."));
  }
})();
