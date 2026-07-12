#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");

const isWin = process.platform === "win32";
const pythonDir = path.join("ml", ".venv", isWin ? "Scripts" : "bin");
const pythonExe = path.join(pythonDir, isWin ? "python.exe" : "python");
const script = path.join("ml", "sidecar.py");

const cp = spawn(pythonExe, [script], {
  stdio: "inherit",
  shell: false,
  cwd: path.resolve(__dirname, ".."),
});

cp.on("exit", (code) => process.exit(code ?? 1));
cp.on("error", (err) => {
  console.error(`[sidecar] failed to start: ${err.message}`);
  console.error(`[sidecar] tried: ${path.resolve(__dirname, "..", pythonExe)}`);
  process.exit(1);
});
