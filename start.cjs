const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const SESSION_URL = process.env.ARENA_SESSION_URL || "http://127.0.0.1:9230";
const PROXY_PORT = process.env.PORT || "9228";
const TOR_DIR = path.join(__dirname, "tor");
const TOR_EXE = path.join(TOR_DIR, "tor-real.exe");
const TORRC = path.join(TOR_DIR, "torrc");

const children = [];

function log(name, message) {
  process.stdout.write(`[${name}] ${message}`);
}

function spawnNode(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  children.push(child);
  child.stdout.on("data", (chunk) => log(name, chunk.toString()));
  child.stderr.on("data", (chunk) => log(name, chunk.toString()));
  child.on("exit", (code, signal) => {
    log(name, `exited code=${code} signal=${signal || "none"}\n`);
    if (!shuttingDown) shutdown(code || 1);
  });
  return child;
}

function spawnTor() {
  if (!fs.existsSync(TOR_EXE)) {
    console.log("[start] Tor não encontrado. Execute: npm install");
    return null;
  }
  const child = spawn(TOR_EXE, ["-f", TORRC], {
    cwd: TOR_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  child.stdout.on("data", (chunk) => log("tor", chunk.toString()));
  child.stderr.on("data", (chunk) => log("tor", chunk.toString()));
  child.on("exit", (code, signal) => {
    log("tor", `exited code=${code} signal=${signal || "none"}\n`);
  });
  log("tor", `iniciado (${TOR_EXE})\n`);
  return child;
}

function waitForPort(port, timeoutMs = 30000) {
  const host = "127.0.0.1";
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (Date.now() > deadline) return reject(new Error(`Timeout esperando porta ${port}`));
      const sock = require("net").createConnection({ host, port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => setTimeout(check, 500));
    };
    check();
  });
}

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`Non-JSON response from ${url}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout waiting for ${url}`)); });
    req.on("error", reject);
  });
}

async function waitForSession() {
  const deadline = Date.now() + Number(process.env.ARENA_SESSION_READY_TIMEOUT_MS || 120000);
  while (Date.now() < deadline) {
    try {
      const status = await getJson(`${SESSION_URL}/status`, 5000);
      if (status?.ok && status.pageOpen) return status;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Arena session did not become ready at ${SESSION_URL}`);
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

(async () => {
  console.log("[start] Arena AI Proxy stack");

  // Auto-start Tor if available and no PROXY env set
  const hasTor = fs.existsSync(TOR_EXE);
  if (hasTor && !process.env.PROXY && !process.env.PROXY_LIST) {
    process.env.PROXY = "socks5://127.0.0.1:9050";
    spawnTor();
    await waitForPort(9050, 30000);
    console.log("[start] Tor pronto (socks5://127.0.0.1:9050)");
  } else if (hasTor) {
    console.log(`[start] Proxy configurado via env: ${process.env.PROXY || process.env.PROXY_LIST}`);
  } else {
    console.log("[start] Tor não encontrado, rodando sem proxy");
  }

  console.log(`[start] session: ${SESSION_URL}`);
  console.log(`[start] proxy:   http://127.0.0.1:${PROXY_PORT}/v1`);

  spawnNode("session", ["arena-session.cjs"]);
  const session = await waitForSession();
  console.log(`[start] session ready: ${session.url || "unknown url"}`);
  console.log("[start] sessão Playwright pronta; proxy iniciando");

  spawnNode("proxy", ["arena-proxy.js"], { PORT: PROXY_PORT });
})();
