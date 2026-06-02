import {render, Box, Text, useInput, useApp} from "ink";
import {createElement as h, useState, useEffect, useCallback} from "react";
import fs from "fs";

const SESSION_URL = process.env.ARENA_SESSION_URL || "http://127.0.0.1:9230";
const ACCOUNTS_PATH = new URL("./accounts.json", import.meta.url);

async function get(pathname, timeoutMs = 10000) {
  try {
    const res = await fetch(`${SESSION_URL}${pathname}`, {signal: AbortSignal.timeout(timeoutMs)});
    return {ok: res.ok, data: await res.json(), status: res.status};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

async function post(pathname, body, timeoutMs = 10000) {
  try {
    const res = await fetch(`${SESSION_URL}${pathname}`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {ok: res.ok, data: await res.json(), status: res.status};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

function pad(s, n) { return String(s || "").padEnd(n); }
function localAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_PATH)) return [];
    const list = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
    return list.map((acc) => {
      const cookies = acc.cookies || [];
      return {
        id: acc.id,
        label: acc.label,
        cookieCount: cookies.length,
        hasArenaAuth: cookies.some((c) => c.name === "arena-auth-prod-v1.0"),
        rateLimited: (acc.rateLimitedUntil || 0) > Date.now(),
        rateLimitedUntil: acc.rateLimitedUntil || 0,
        lastUsedAt: acc.lastUsedAt || 0,
        createdAt: acc.createdAt || 0,
      };
    });
  } catch {
    return [];
  }
}
function statusColor(acc) {
  if (acc.rateLimited) return "yellow";
  if (acc.hasArenaAuth) return "green";
  return "red";
}
function statusText(acc) {
  if (acc.rateLimited) return "⏳ LIMIT";
  if (acc.hasArenaAuth) return "✅ OK";
  return "❌ NOAUTH";
}

// ─── Text Input Component ──────────────────────────────────

function TextInput({prompt, onSubmit, onCancel}) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.return && value.trim()) {
      onSubmit(value.trim());
    } else if (key.escape) {
      onCancel();
    } else if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
    } else if (input.length === 1 && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });
  return h(Box, {},
    h(Text, {color: "cyan"}, `${prompt}: `),
    h(Text, {bold: true}, value || ""),
    h(Text, {color: "gray"}, value ? " █" : " (digite e Enter)"),
  );
}

// ─── Confirm Component ─────────────────────────────────────

function Confirm({prompt, onYes, onNo}) {
  useInput((input) => {
    if (input === "s" || input === "S" || input === "y" || input === "Y" || input === "\r") onYes();
    if (input === "n" || input === "N") onNo();
  });
  return h(Text, {color: "yellow"}, `${prompt} (s/N): `);
}

// ─── App ───────────────────────────────────────────────────

function App() {
  const {exit} = useApp();
  const [accounts, setAccounts] = useState([]);
  const [message, setMessage] = useState({text: "", color: "gray"});
  const [mode, setMode] = useState("menu"); // menu | add | relogin | remove | confirm | busy
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingId, setPendingId] = useState(null);
  const [busyText, setBusyText] = useState("");

  const load = useCallback(async () => {
    const res = await get("/accounts");
    if (res.ok) {
      setAccounts(res.data.accounts || []);
      return;
    }
    const fallback = localAccounts();
    setAccounts(fallback);
    setMessage({
      text: fallback.length > 0
        ? `Session offline (${res.error}). Mostrando accounts.json local; use npm start para gerenciar login.`
        : `Session offline (${res.error}). Nenhuma conta local encontrada.`,
      color: "yellow",
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addAccount(label) {
    setMode("busy");
    setBusyText(`Abrindo navegador para login: "${label}"...`);
    setMessage({text: "Faça login na janela aberta. Aguardando...", color: "cyan"});
    const res = await post("/accounts/login", {label}, 600000);
    if (res.ok) {
      setMessage({text: `✅ Conta "${label}" adicionada (${res.data?.cookieCount} cookies)`, color: "green"});
    } else {
      setMessage({text: `❌ ${res.data?.error || res.error || "falhou"}`, color: "red"});
    }
    await load();
    setMode("menu");
  }

  async function reloginAccount(id) {
    const acc = accounts.find((a) => a.id === id);
    setMode("busy");
    setBusyText(`Re-fazendo login: "${acc?.label || id}"...`);
    setMessage({text: "Faça login na janela aberta.", color: "cyan"});
    const res = await post("/accounts/re-login", {id}, 600000);
    if (res.ok) {
      setMessage({text: `✅ Re-login OK: ${acc?.label || id}`, color: "green"});
    } else {
      setMessage({text: `❌ ${res.data?.error || res.error || "falhou"}`, color: "red"});
    }
    await load();
    setMode("menu");
  }

  async function removeAccount(id) {
    const acc = accounts.find((a) => a.id === id);
    const res = await post("/accounts/remove", {id});
    if (res.ok) {
      setMessage({text: `🗑️ Conta removida: ${acc?.label || id}`, color: "green"});
    } else {
      setMessage({text: `❌ ${res.data?.error || res.error || "falhou"}`, color: "red"});
    }
    await load();
    setMode("menu");
  }

  useInput((input) => {
    if (mode !== "menu") return;
    switch (input) {
      case "1":
        setPendingLabel("");
        setMode("add");
        setMessage({text: "Digite um nome para a nova conta", color: "cyan"});
        break;
      case "2": {
        if (accounts.length === 0) {
          setMessage({text: "Nenhuma conta para re-login.", color: "red"});
          return;
        }
        setPendingId(null);
        setMode("relogin");
        setMessage({text: "Digite o número da conta", color: "cyan"});
        break;
      }
      case "3": {
        if (accounts.length === 0) {
          setMessage({text: "Nenhuma conta para remover.", color: "red"});
          return;
        }
        setPendingId(null);
        setMode("remove");
        setMessage({text: "Digite o número da conta", color: "yellow"});
        break;
      }
      case "4":
        setMode("status");
        break;
      case "0":
      case "q":
        exit();
        break;
    }
  });

  // ─── Render ──────────────────────────────────

  const header = h(Box, {},
    h(Text, {bold: true, color: "green"}, " Arena AI Proxy "),
    h(Text, {color: "gray"}, "— Gerenciar Contas "),
  );

  const tableHeader = h(Box, {gap: 1},
    h(Box, {width: 3}, h(Text, {bold: true, color: "cyan"}, "#")),
    h(Box, {width: 10}, h(Text, {bold: true, color: "cyan"}, "Status")),
    h(Box, {width: 26}, h(Text, {bold: true, color: "cyan"}, "Label")),
    h(Box, {width: 8}, h(Text, {bold: true, color: "cyan"}, "Cookies")),
  );

  const sep = h(Box, {gap: 1},
    h(Box, {width: 3}, h(Text, {color: "gray"}, "─")),
    h(Box, {width: 10}, h(Text, {color: "gray"}, "──────────")),
    h(Box, {width: 26}, h(Text, {color: "gray"}, "──────────────────────────")),
    h(Box, {width: 8}, h(Text, {color: "gray"}, "───────")),
  );

  const rows = accounts.length === 0
    ? [h(Box, {key: "empty"}, h(Text, {color: "gray"}, "  Nenhuma conta cadastrada."))]
    : accounts.map((acc, i) =>
        h(Box, {key: acc.id, gap: 1},
          h(Box, {width: 3}, h(Text, {}, String(i + 1))),
          h(Box, {width: 10}, h(Text, {color: statusColor(acc)}, statusText(acc))),
          h(Box, {width: 26}, h(Text, {wrap: "truncate-end"}, acc.label || acc.id)),
          h(Box, {width: 8}, h(Text, {}, String(acc.cookieCount))),
        )
      );

  const menuBar = h(Box, {marginTop: 1},
    h(Text, {color: "gray"}, " [1] Add  [2] Re-login  [3] Remover  [4] Status  [0] Sair "),
  );

  const statusLine = h(Box, {},
    h(Text, {color: message.color}, message.text),
  );

  // ─── Sub-modes ──────────────────────────────────

  let body;
  if (mode === "add") {
    body = h(TextInput, {
      prompt: "Nome da conta",
      onSubmit: (label) => addAccount(label),
      onCancel: () => { setMode("menu"); setMessage({text: "", color: "gray"}); },
    });
  } else if (mode === "relogin") {
    body = h(TextInput, {
      prompt: "Número da conta",
      onSubmit: (n) => {
        const idx = parseInt(n) - 1;
        if (idx >= 0 && idx < accounts.length) {
          reloginAccount(accounts[idx].id);
        } else {
          setMessage({text: "Número inválido.", color: "red"});
          setMode("menu");
        }
      },
      onCancel: () => { setMode("menu"); setMessage({text: "", color: "gray"}); },
    });
  } else if (mode === "remove") {
    body = h(TextInput, {
      prompt: "Número da conta",
      onSubmit: (n) => {
        const idx = parseInt(n) - 1;
        if (idx >= 0 && idx < accounts.length) {
          setPendingId(accounts[idx].id);
          setPendingLabel(accounts[idx].label);
          setMode("confirm");
        } else {
          setMessage({text: "Número inválido.", color: "red"});
          setMode("menu");
        }
      },
      onCancel: () => { setMode("menu"); setMessage({text: "", color: "gray"}); },
    });
  } else if (mode === "confirm") {
    body = h(Confirm, {
      prompt: `Remover "${pendingLabel}"?`,
      onYes: () => removeAccount(pendingId),
      onNo: () => { setMode("menu"); setMessage({text: "", color: "gray"}); },
    });
  } else if (mode === "status") {
    const statusRows = accounts.length === 0
      ? [h(Text, {color: "gray"}, "  Nenhuma conta.")]
      : accounts.map((acc) => {
          const until = acc.rateLimitedUntil ? new Date(acc.rateLimitedUntil).toLocaleTimeString() : "✅";
          const remaining = acc.rateLimitedUntil
            ? `${Math.max(0, Math.ceil((acc.rateLimitedUntil - Date.now()) / 1000))}s`
            : "—";
          return h(Box, {key: acc.id, flexDirection: "column"},
            h(Text, {bold: true}, `  ${acc.label || acc.id}`),
            h(Text, {color: "gray"},
              `    Auth: ${acc.hasArenaAuth ? "✅" : "❌"}  ` +
              `Rate limit: ${acc.rateLimited ? "⏳" : "✅"}  ` +
              `Disponível em: ${until} (${remaining})`
            ),
          );
        });

    body = h(Box, {flexDirection: "column"},
      h(Text, {bold: true, color: "cyan"}, " Status de Rate Limit:"),
      h(Box, {marginTop: 1}, ...statusRows),
      h(Box, {marginTop: 1}, h(Text, {color: "gray"}, " Pressione qualquer tecla para voltar ")),
    );

    // Wait for any key to go back
    const goBack = (input) => {
      if (input) { setMode("menu"); setMessage({text: "", color: "gray"}); }
    };
    // We handle this via the useInput at the top level by checking mode
  } else if (mode === "busy") {
    body = h(Box, {},
      h(Text, {color: "yellow"}, ` ${busyText}`),
    );
  }

  // For status mode, we need a special key handler
  // Ink's useInput is registered at the top level, so we handle mode switches there
  // But we need a way to go back from status mode
  // Let's use a nested useInput
  function StatusHandler() {
    useInput(() => {
      if (mode === "status") {
        setMode("menu");
        setMessage({text: "", color: "gray"});
      }
    });
    return null;
  }

  return h(Box, {flexDirection: "column", padding: 1},
    header,
    h(Box, {marginTop: 1, flexDirection: "column"},
      tableHeader,
      sep,
      ...rows,
    ),
    menuBar,
    h(Box, {marginTop: 1}, body || statusLine),
    mode === "status" ? h(StatusHandler) : null,
  );
}

// ─── CLI Entry ─────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--status")) {
  const res = await get("/accounts");
  const list = res.ok ? (res.data?.accounts || []) : localAccounts();
  console.log(`Contas: ${list.length}`);
  for (const acc of list) {
    const state = acc.rateLimited ? "rate-limited" : acc.hasArenaAuth ? "ok" : "no-auth";
    console.log(`  ${acc.label || acc.id}: ${state} (${acc.cookieCount} cookies)`);
  }
  if (!res.ok) console.log(`Session service offline: ${res.error}; usando accounts.json local`);
  process.exit(0);
}

const {waitUntilExit} = render(h(App));
await waitUntilExit();
