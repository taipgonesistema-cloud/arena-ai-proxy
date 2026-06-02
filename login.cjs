const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const accountsPath = path.join(__dirname, "accounts.json");
const hasAccounts = fs.existsSync(accountsPath);
let accounts = [];
if (hasAccounts) {
  try { accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8")); }
  catch {}
}

if (accounts.length > 0) {
  const p = spawn("node", [path.join(__dirname, "arena-accounts.cjs")], {
    stdio: "inherit",
    cwd: __dirname,
  });
  p.on("exit", (code) => process.exit(code));
} else {
  const p = spawn("node", [path.join(__dirname, "arena-session.cjs"), "--login-only"], {
    stdio: "inherit",
    cwd: __dirname,
  });
  p.on("exit", (code) => process.exit(code));
}
