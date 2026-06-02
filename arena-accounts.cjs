const http = require("http");
const path = require("path");
const readline = require("readline");

const SESSION_URL = process.env.ARENA_SESSION_URL || "http://127.0.0.1:9230";

let rl;

function clear() {
  process.stdout.write("\x1B[2J\x1B[0f");
}

function header() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       Arena AI Proxy - Gerenciar Contas     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
}

async function sessionGet(pathname, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const req = http.get(`${SESSION_URL}${pathname}`, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve({ ok: res.statusCode < 400, data: JSON.parse(data), status: res.statusCode }); }
        catch { resolve({ ok: false, error: "parse error", raw: data }); }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
  });
}

function sessionPost(pathname, body, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const options = {
      hostname: "127.0.0.1",
      port: 9230,
      path: pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    };
    const req = http.request(options, (res) => {
      let responseData = "";
      res.on("data", (c) => responseData += c);
      res.on("end", () => {
        try { resolve({ ok: res.statusCode < 400, data: JSON.parse(responseData), status: res.statusCode }); }
        catch { resolve({ ok: false, error: "parse error", raw: responseData }); }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.write(data);
    req.end();
  });
}

function pad(s, n) { return String(s || "").padEnd(n); }

async function showAccounts() {
  const result = await sessionGet("/accounts");
  const list = result?.ok ? (result.data?.accounts || []) : [];
  header();
  if (list.length === 0) {
    console.log("  Nenhuma conta cadastrada.\n");
    return list;
  }
  console.log(`  ${pad("#", 3)} ${pad("Status", 8)} ${pad("Label", 25)} Cookies  Auth`);
  console.log(`  ${pad("", 3, "-")} ${pad("", 8, "-")} ${pad("", 25, "-")} ${pad("", 7, "-")} ${pad("", 4, "-")}`);
  list.forEach((acc, i) => {
    const status = acc.rateLimited ? "⏳LIMIT" : acc.hasArenaAuth ? "✅OK" : "❌NOAUTH";
    const label = acc.label || acc.id;
    console.log(`  ${pad(i + 1, 3)} ${pad(status, 8)} ${pad(label.slice(0, 24), 25)} ${pad(acc.cookieCount, 7)} ${acc.hasArenaAuth ? "✅" : "❌"}`);
  });
  console.log("");
  return list;
}

async function loginNewAccount() {
  return new Promise((resolve) => {
    console.log("─ Adicionar Conta (Login Manual) ─");
    console.log("  Uma janela do navegador será aberta.");
    console.log("  Faça login manualmente na sua conta Arena.");
    console.log("  Após o login, os cookies serão salvos automaticamente.");
    console.log("");
    rl.question("  Nome/identificador da conta: ", async (label) => {
      const name = label.trim() || `Conta ${Date.now()}`;
      console.log(`  Abrindo navegador para: ${name}...`);
      const result = await sessionPost("/accounts/login", { label: name }, 600000);
      if (result.ok) {
        console.log(`  ✅ Conta "${name}" adicionada com sucesso! (${result.data?.cookieCount || 0} cookies)\n`);
        resolve(true);
      } else {
        console.log(`  ❌ Erro: ${result?.data?.error || result.error}\n`);
        resolve(false);
      }
    });
  });
}

async function reLoginAccount() {
  const list = await showAccounts();
  if (list.length === 0) return false;

  const choice = await new Promise((resolve) => {
    console.log("─ Re-Login de Conta ─");
    rl.question("  Número da conta (0 para cancelar): ", (a) => resolve(parseInt(a) || 0));
  });
  if (choice < 1 || choice > list.length) { console.log("  Cancelado.\n"); return false; }

  const acc = list[choice - 1];
  console.log(`  Re-fazendo login de: ${acc.label || acc.id}...`);
  const result = await sessionPost("/accounts/re-login", { id: acc.id }, 600000);
  if (result.ok) {
    console.log(`  ✅ Re-login OK! (${result.data?.cookieCount || 0} cookies)\n`);
  } else {
    console.log(`  ❌ Erro: ${result?.data?.error || result.error}\n`);
  }
  return result.ok;
}

async function removeAccount() {
  const list = await showAccounts();
  if (list.length === 0) return false;

  const choice = await new Promise((resolve) => {
    console.log("─ Remover Conta ─");
    rl.question("  Número da conta (0 para cancelar): ", (a) => resolve(parseInt(a) || 0));
  });
  if (choice < 1 || choice > list.length) { console.log("  Cancelado.\n"); return false; }

  const acc = list[choice - 1];
  const confirm = await new Promise((resolve) => {
    rl.question(`  Remover "${acc.label || acc.id}"? (s/N): `, (a) => resolve(a.toLowerCase() === "s"));
  });
  if (!confirm) { console.log("  Cancelado.\n"); return false; }

  const result = await sessionPost("/accounts/remove", { id: acc.id });
  if (result.ok) {
    console.log(`  Conta removida.\n`);
  } else {
    console.log(`  Erro: ${result?.data?.error || result.error}\n`);
  }
  return result.ok;
}

async function showRateLimits() {
  const result = await sessionGet("/accounts");
  const list = result?.ok ? (result.data?.accounts || []) : [];
  header();
  if (list.length === 0) {
    console.log("  Nenhuma conta.\n");
    return;
  }
  console.log("  Status de Rate Limit:");
  console.log("  ─────────────────────");
  for (const acc of list) {
    const until = acc.rateLimitedUntil ? new Date(acc.rateLimitedUntil).toLocaleTimeString() : "-";
    const remaining = acc.rateLimitedUntil ? Math.max(0, Math.ceil((acc.rateLimitedUntil - Date.now()) / 1000)) + "s" : "✅";
    console.log(`  ${acc.label || acc.id}`);
    console.log(`    Auth: ${acc.hasArenaAuth ? "✅" : "❌"}  Rate limit: ${acc.rateLimited ? "⏳" : "✅"}  Disponível em: ${until} (${remaining})`);
  }
  console.log("");
}

async function menu() {
  let running = true;
  while (running) {
    await showAccounts();
    console.log("  Opções:");
    console.log("    1. Adicionar conta (login manual)");
    console.log("    2. Re-fazer login de uma conta");
    console.log("    3. Remover conta");
    console.log("    4. Status de rate limit");
    console.log("    0. Sair");
    console.log("");

    const answer = await new Promise((resolve) => {
      rl.question("  Escolha: ", resolve);
    });
    clear();

    switch (answer.trim()) {
      case "1": await loginNewAccount(); break;
      case "2": await reLoginAccount(); break;
      case "3": await removeAccount(); break;
      case "4": await showRateLimits(); break;
      case "0": running = false; break;
      default: console.log("  Opção inválida.\n");
    }
  }
  console.log("  Até logo!\n");
  rl.close();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    const result = await sessionGet("/accounts");
    const list = result?.ok ? (result.data?.accounts || []) : [];
    console.log(`Contas: ${list.length}`);
    for (const acc of list) {
      const state = acc.rateLimited ? "rate-limited" : acc.hasArenaAuth ? "ok" : "no-auth";
      console.log(`  ${acc.label || acc.id}: ${state} (${acc.cookieCount} cookies)`);
    }
    if (!result.ok) console.log(`Session service: ${result.error}`);
    process.exit(0);
  }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  clear();
  await menu();
}

main().catch((err) => { console.error(err); process.exit(1); });
