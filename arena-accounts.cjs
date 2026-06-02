const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ACCOUNTS_PATH = path.join(__dirname, "accounts.json");
const SESSION_URL = process.env.ARENA_SESSION_URL || "http://127.0.0.1:9230";

let rl;

function clear() {
  process.stdout.write("\x1B[2J\x1B[0f");
}

function header() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║        Arena AI Proxy - Gerenciar Contas    ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8")); }
  catch { return []; }
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2) + "\n");
}

async function sessionGet(path, timeoutMs = 10000) {
  try {
    const res = await fetch(`${SESSION_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { ok: res.ok, data: JSON.parse(text), raw: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sessionPost(path, body, timeoutMs = 10000) {
  try {
    const res = await fetch(`${SESSION_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { ok: res.ok, data: JSON.parse(text), raw: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function statusIcon(account, statusData) {
  if (!account) return "⬜";
  const s = statusData?.find((a) => a.email === account.email);
  if (!s) return "⬜";
  if (s.rateLimited) return "⏳";
  if (s.loggedIn && s.hasArenaAuth) return "✅";
  if (s.loggedIn) return "⚠️";
  return "❌";
}

async function showAccounts(accounts) {
  const status = await sessionGet("/accounts").catch(() => ({ data: { accounts: [] } }));
  const statusData = status?.data?.accounts || [];

  header();
  if (accounts.length === 0) {
    console.log("  Nenhuma conta configurada.\n");
    return [];
  }

  console.log("  #  Status  Email");
  console.log("  ─  ──────  ─────");
  accounts.forEach((acc, i) => {
    const icon = statusIcon(acc, statusData);
    const s = statusData?.find((a) => a.email === acc.email);
    let label = `  ${String(i + 1).padStart(2)}  ${icon}     ${acc.email}`;
    if (s?.rateLimited) label += "  (rate-limited)";
    console.log(label);
  });
  console.log("");
  return statusData;
}

async function addAccount() {
  return new Promise((resolve) => {
    console.log("─ Adicionar Conta ─");
    rl.question("  Email: ", (email) => {
      if (!email.trim()) { console.log("  Cancelado.\n"); resolve(false); return; }
      rl.question("  Senha: ", (password) => {
        if (!password) { console.log("  Cancelado.\n"); resolve(false); return; }
        const accounts = loadAccounts();
        if (accounts.some((a) => a.email === email.trim())) {
          console.log("  Conta já existe.\n");
          resolve(false);
          return;
        }
        accounts.push({ email: email.trim(), password });
        saveAccounts(accounts);
        console.log(`  Conta ${email.trim()} adicionada.\n`);
        resolve(true);
      });
    });
  });
}

async function removeAccount() {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log("  Nenhuma conta para remover.\n");
    return false;
  }

  return new Promise((resolve) => {
    console.log("─ Remover Conta ─");
    console.log("  Escolha o número da conta (ou 0 para cancelar):");
    accounts.forEach((acc, i) => console.log(`  ${i + 1}. ${acc.email}`));
    rl.question("  > ", (answer) => {
      const num = parseInt(answer);
      if (!num || num < 1 || num > accounts.length) {
        console.log("  Cancelado.\n");
        resolve(false);
        return;
      }
      const removed = accounts.splice(num - 1, 1);
      saveAccounts(accounts);
      console.log(`  Conta ${removed[0].email} removida.\n`);
      resolve(true);
    });
  });
}

async function loginAll() {
  console.log("  Iniciando login de todas as contas...");
  const result = await sessionPost("/accounts/login-all");
  if (!result.ok) {
    console.log(`  Erro: ${result?.data?.error || result.error}\n`);
    return;
  }
  const res = result.data?.results || [];
  const ok = res.filter((r) => r.ok).length;
  const fail = res.filter((r) => !r.ok).length;
  console.log(`  Login: ${ok} ok, ${fail} falha`);
  for (const r of res) {
    if (!r.ok) console.log(`    ${r.email}: ${r.error || "falhou"}`);
  }
  console.log("");
}

async function loginSingle() {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log("  Nenhuma conta configurada.\n");
    return;
  }
  const email = await new Promise((resolve) => {
    console.log("─ Fazer Login de uma Conta ─");
    console.log("  Escolha o número da conta (ou 0 para cancelar):");
    accounts.forEach((acc, i) => console.log(`  ${i + 1}. ${acc.email}`));
    rl.question("  > ", (answer) => {
      const num = parseInt(answer);
      if (!num || num < 1 || num > accounts.length) resolve(null);
      else resolve(accounts[num - 1]);
    });
  });
  if (!email) { console.log("  Cancelado.\n"); return; }

  console.log(`  Fazendo login: ${email.email}...`);
  const result = await sessionPost("/accounts/login", { email: email.email, password: email.password }, 120000);
  if (result.ok) {
    console.log("  Login OK!\n");
  } else {
    console.log(`  Erro: ${result?.data?.error || result.error}\n`);
  }
}

async function showRateLimits() {
  const status = await sessionGet("/accounts").catch(() => ({ data: { accounts: [] } }));
  const list = status?.data?.accounts || [];
  header();
  if (list.length === 0) {
    console.log("  Nenhuma conta registrada no session service.\n");
    return;
  }
  console.log("  Status de Rate Limit:");
  console.log("  ─────────────────────");
  for (const acc of list) {
    const until = acc.rateLimitedUntil ? new Date(acc.rateLimitedUntil).toLocaleTimeString() : "-";
    const remaining = acc.rateLimitedUntil ? Math.max(0, Math.ceil((acc.rateLimitedUntil - Date.now()) / 1000)) + "s" : "-";
    console.log(`  ${acc.email}`);
    console.log(`    Logged in: ${acc.loggedIn ? "✅" : "❌"}  Auth cookie: ${acc.hasArenaAuth ? "✅" : "❌"}  Rate limited: ${acc.rateLimited ? "⏳" : "✅"}  Cooldown até: ${until} (${remaining})`);
  }
  console.log("");
}

async function menu() {
  let running = true;
  while (running) {
    const accounts = loadAccounts();
    const statusData = await showAccounts(accounts);

    console.log("  Opções:");
    console.log("    1. Adicionar conta");
    console.log("    2. Remover conta");
    console.log("    3. Login de todas as contas");
    console.log("    4. Login de uma conta");
    console.log("    5. Status de rate limit");
    console.log("    0. Sair");
    console.log("");

    const answer = await new Promise((resolve) => {
      rl.question("  Escolha: ", resolve);
    });
    clear();

    switch (answer.trim()) {
      case "1":
        await addAccount();
        break;
      case "2":
        await removeAccount();
        break;
      case "3":
        await loginAll();
        break;
      case "4":
        await loginSingle();
        break;
      case "5":
        await showRateLimits();
        break;
      case "0":
        running = false;
        break;
      default:
        console.log("  Opção inválida.\n");
    }
  }
  console.log("  Até logo!\n");
  rl.close();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--add") && args.includes("--email") && args.includes("--password")) {
    const email = args[args.indexOf("--email") + 1];
    const password = args[args.indexOf("--password") + 1];
    if (email && password) {
      const accounts = loadAccounts();
      if (!accounts.some((a) => a.email === email)) {
        accounts.push({ email, password });
        saveAccounts(accounts);
        console.log(`Conta ${email} adicionada.`);
      } else {
        console.log(`Conta ${email} já existe.`);
      }
      process.exit(0);
    }
  }

  if (args.includes("--remove") && args.includes("--email")) {
    const email = args[args.indexOf("--email") + 1];
    if (email) {
      let accounts = loadAccounts();
      accounts = accounts.filter((a) => a.email !== email);
      saveAccounts(accounts);
      console.log(`Conta ${email} removida.`);
      process.exit(0);
    }
  }

  if (args.includes("--status")) {
    const accounts = loadAccounts();
    const status = await sessionGet("/accounts").catch(() => ({ data: { accounts: [] } }));
    const list = status?.data?.accounts || [];
    console.log(`Contas configuradas: ${accounts.length}`);
    for (const acc of accounts) {
      const s = list.find((a) => a.email === acc.email);
      const state = s ? (s.rateLimited ? "rate-limited" : s.loggedIn ? "logged-in" : "not-logged-in") : "no-session";
      console.log(`  ${acc.email}: ${state}`);
    }
    if (list.length === 0) console.log("  Session service não disponível ou sem contas registradas.");
    process.exit(0);
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  clear();
  await menu();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
