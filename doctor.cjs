const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const ROOT = __dirname;
const SESSION_URL = process.env.ARENA_SESSION_URL || "http://127.0.0.1:9230";
const PROXY_URL = process.env.ARENA_PROXY_URL || "http://127.0.0.1:9228";

function line(ok, label, detail = "") {
  const mark = ok ? "OK " : "ERR";
  console.log(`[${mark}] ${label}${detail ? ` - ${detail}` : ""}`);
}

function checkPort(port, host = "127.0.0.1", timeoutMs = 1500) {
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

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) }); }
        catch { reject(new Error(`non-json ${res.statusCode}: ${data.slice(0, 160)}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function localAccounts() {
  const accountsPath = path.join(ROOT, "accounts.json");
  if (!fs.existsSync(accountsPath)) return [];
  try { return JSON.parse(fs.readFileSync(accountsPath, "utf8")); }
  catch { return []; }
}

(async () => {
  console.log("Arena AI Proxy Doctor\n");

  const torExe = path.join(ROOT, "tor", "tor-real.exe");
  const torrc = path.join(ROOT, "tor", "torrc");
  const accounts = localAccounts();

  line(fs.existsSync(torExe), "Tor instalado", torExe);
  line(fs.existsSync(torrc), "torrc encontrado", torrc);
  line(accounts.length > 0, "Contas locais", `${accounts.length} conta(s)`);
  for (const acc of accounts) {
    const cookies = acc.cookies || [];
    const hasAuth = cookies.some((c) => c.name === "arena-auth-prod-v1.0");
    line(hasAuth, `Conta ${acc.label || acc.id}`, `${cookies.length} cookies`);
  }

  const torSocks = await checkPort(9050);
  const torControl = await checkPort(9051);
  const sessionPort = await checkPort(9230);
  const proxyPort = await checkPort(9228);
  line(torSocks, "Tor SOCKS", "127.0.0.1:9050");
  line(torControl, "Tor ControlPort", "127.0.0.1:9051");
  line(sessionPort, "Session service", SESSION_URL);
  line(proxyPort, "OpenAI proxy", `${PROXY_URL}/v1`);

  if (sessionPort) {
    try {
      const health = await getJson(`${SESSION_URL}/health`);
      line(health.data?.ok, "Session /health", JSON.stringify(health.data?.checks || {}));
    } catch (err) {
      line(false, "Session /health", err.message);
    }
  }

  if (proxyPort) {
    try {
      const models = await getJson(`${PROXY_URL}/v1/models`);
      const count = Array.isArray(models.data?.data) ? models.data.data.length : 0;
      line(models.ok && count > 0, "Proxy /v1/models", `${count} modelo(s)`);
    } catch (err) {
      line(false, "Proxy /v1/models", err.message);
    }
  }

  console.log("\nDicas:");
  console.log("- Se Tor não estiver instalado: npm install");
  console.log("- Se portas 9230/9228 estiverem offline: npm start");
  console.log("- Para trocar circuito Tor: POST http://127.0.0.1:9230/tor/newnym");
})();
