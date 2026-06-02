const { spawn } = require("child_process");
const path = require("path");

const p = spawn("node", [path.join(__dirname, "arena-accounts.js")], {
  stdio: "inherit",
  cwd: __dirname,
});
p.on("exit", (code) => process.exit(code));
