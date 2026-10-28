/**
 * mmo-chip desktop shell (Electron main).
 *
 * The app is a UI over the Node backend: this process spawns the backend as a
 * plain Node child (`ELECTRON_RUN_AS_NODE=1` turns the Electron binary into a
 * Node runtime) and opens a frameless window on the URL Express serves. The
 * resources root mirrors the repo layout (resources/app = repo root), so the
 * backend's own netlist-export re-spawn keeps working unchanged:
 *
 *   resources/
 *     app/            backend/dist + frontend/dist + shared + node_modules
 *     bin/            bundled ngspice / vyges-lvs (optional)
 *
 * The launcher (desktop/launcher) sets ELECTRON_DISABLE_SANDBOX and spawns
 * this exe as mmo-chip-app.exe: on some machines Chromium's sandbox
 * initialization crashes before main.js even runs, so "mmo-chip.exe" is a
 * tiny launcher and the Electron binary sits next to it.
 *
 * Dev shortcut: `electron . --dev-vite` attaches to an already running
 * `npm run dev` stack (Vite on :5173, backend on :3001) without spawning one.
 */
"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const DEV_VITE = process.argv.includes("--dev-vite");
const BACKEND_PORT = Number(process.env.MMOCHECK_PORT ?? process.env.PORT ?? 3101);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const VITE_URL = "http://localhost:5173";

const resourcesRoot = path.isAbsolute(process.env.MMOCHECK_RESOURCES ?? "")
  ? path.resolve(process.env.MMOCHECK_RESOURCES)
  : path.join(__dirname, "..", "resources");
const appRoot = path.join(resourcesRoot, "app");
const binDir = path.join(resourcesRoot, "bin");

let backend = null;
let mainWindow = null;
let quitting = false;

// ── logging (double-click launches have no console) ───────────────

let logDir = null;
let logFile = null;

function initLogging() {
  try {
    logDir = app.getPath("logs");
  } catch {
    logDir = path.join(resourcesRoot, "logs");
  }
  if (!ensureWritable(logDir)) {
    logDir = path.join(resourcesRoot, "logs");
  }
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, "mmo-chip.log");
    log(`— session start (argv=${JSON.stringify(process.argv)})`);
  } catch {
    logFile = null;
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (logFile) {
    try {
      // Keep the file bounded; the newest session matters most.
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) {
        fs.renameSync(logFile, logFile + ".old");
      }
      fs.appendFileSync(logFile, line + "\n");
    } catch {}
  }
  console.log(line);
}

function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function showError(title, detail) {
  log(`ERROR: ${title} — ${detail}`);
  try {
    dialog.showMessageBoxSync({
      type: "error",
      title: "mmo-chip",
      message: title,
      detail: `${detail}\n\nLog: ${logFile ?? "(log unavailable)"}`
    });
  } catch {}
}

// ── user data location ────────────────────────────────────────────

let dataDirChoice = null;

function initDataDir() {
  // Pin the profile dir to the product name: after the launcher rename the
  // Electron exe is "mmo-chip-app.exe", which would otherwise become the
  // profile folder name.
  const preferred = path.join(app.getPath("appData"), "mmo-chip");
  if (ensureWritable(preferred)) {
    app.setPath("userData", preferred);
    app.setPath("logs", path.join(preferred, "logs"));
    dataDirChoice = preferred;
    return;
  }
  // Locked-down machines that deny writes to the user profile: keep all
  // state next to the resources (portable mode) instead of failing silently.
  const portable = path.join(resourcesRoot, "portable-data");
  fs.mkdirSync(portable, { recursive: true });
  app.setPath("userData", portable);
  app.setPath("logs", path.join(portable, "logs"));
  dataDirChoice = `${portable} (portable fallback — user profile not writable)`;
}

// ── small helpers ─────────────────────────────────────────────────

/** Pick the first bundled binary so the backend never probes the system. */
function bundledBinary(names) {
  for (const name of names) {
    const p = path.join(binDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function waitForBackend(timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(`${BACKEND_URL}/api/health/`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else retry();
      });
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`backend did not start within ${timeoutMs / 1000}s`));
        return;
      }
      setTimeout(probe, 250);
    };
    probe();
  });
}

// ── backend child ─────────────────────────────────────────────────

function startBackend() {
  const entry = path.join(appRoot, "backend", "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`backend bundle missing: ${entry} — run npm run desktop:build:win first`);
  }

  const env = {
    ...process.env,
    // Run the Electron binary as a plain Node runtime. Inherited by any
    // grandchild the backend spawns (netlist-export), so the whole chain
    // behaves exactly like the dev setup.
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(BACKEND_PORT),
    // Follow the pinned user-data dir (the backend writes dies/overlays here).
    CHIPTOOL_DATA_ROOT: path.join(app.getPath("userData"), "data"),
    CHIPTOOL_FRONTEND_DIST: path.join(appRoot, "frontend", "dist"),
    CHIPTOOL_APP_ROOT: appRoot,
    NO_COLOR: "1"
  };

  // Bundled simulators beat whatever the system PATH offers. ngspice keeps the
  // official Spice64 layout (share/ init files resolve relative to the binary).
  const ngspice = bundledBinary([
    "Spice64/bin/ngspice_con.exe",
    "ngspice_con.exe",
    "ngspice_con",
    "ngspice.exe",
    "ngspice"
  ]);
  const lvs = bundledBinary(["vyges-lvs.exe", "vyges-lvs"]);
  if (ngspice) env.NGSPICE_BIN = ngspice;
  if (lvs) env.LVS_CLI_PATH = lvs;
  // Make the bundled helper binaries resolvable by anything that `which`es.
  if (process.platform === "win32") {
    env.PATH = `${binDir};${env.PATH ?? ""}`;
  } else {
    env.PATH = `${binDir}:${env.PATH ?? ""}`;
  }

  backend = spawn(
    process.execPath,
    // --import tsx: "shared" ships as TS sources inside node_modules, and
    // plain Node refuses type stripping there — same trick the backend's own
    // netlist-export spawn already uses.
    ["--import", "tsx", entry],
    {
      cwd: appRoot,
      env,
      windowsHide: true,
      // The backend log lands next to the shell log: double-click launches
      // have no console, so this file is the only visible trace otherwise.
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  backend.stdout.on("data", (chunk) => log(`[backend] ${String(chunk).trimEnd()}`));
  backend.stderr.on("data", (chunk) => log(`[backend:err] ${String(chunk).trimEnd()}`));
  backend.on("error", (error) => log(`backend spawn failed: ${error.message}`));
  backend.on("exit", (code) => {
    backend = null;
    if (code && !quitting) log(`backend exited with code ${code}`);
  });
  return backend;
}

function stopBackend() {
  if (!backend) return;
  const child = backend;
  backend = null;
  if (process.platform === "win32") {
    // Node kills only the direct child; the backend may have spawned helpers.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
      try {
        child.kill();
      } catch {}
    });
  } else {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  }
}

// ── window ────────────────────────────────────────────────────────

function createWindow() {
  const { width = 1600, height = 960, maximized = true } = loadWindowBounds();
  mainWindow = new BrowserWindow({
    // Frameless in the app's own style: drag + controls live in the TopBar.
    frame: false,
    backgroundColor: "#0b0d10",
    minWidth: 900,
    minHeight: 600,
    width,
    height,
    show: false,
    title: "mmo-chip",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  if (maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("resize", saveWindowBoundsSoon);
  mainWindow.on("maximize", () => mainWindow?.webContents.send("desktop:state", maximizedState()));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("desktop:state", maximizedState()));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    showError("Окно приложения закрылось", `renderer: ${details.reason} (exit code ${details.exitCode})`);
  });

  // Open external links (docs, sourceforge …) in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(DEV_VITE ? VITE_URL : BACKEND_URL);
}

function maximizedState() {
  return { maximized: !!mainWindow?.isMaximized() };
}

function loadWindowBounds() {
  try {
    const file = path.join(app.getPath("userData"), "window.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

let boundsTimer = null;
function saveWindowBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      fs.writeFileSync(
        path.join(app.getPath("userData"), "window.json"),
        JSON.stringify({
          maximized: mainWindow.isMaximized(),
          ...(mainWindow.isMaximized() ? {} : mainWindow.getBounds())
        })
      );
    } catch {}
  }, 400);
}

// ── IPC from the frameless title bar ──────────────────────────────

ipcMain.on("desktop:window", (_event, action) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  switch (action) {
    case "minimize":
      win.minimize();
      break;
    case "toggle-maximize":
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case "close":
      win.close();
      break;
    default:
      break;
  }
});
ipcMain.handle("desktop:info", () => ({
  platform: process.platform,
  version: app.getVersion(),
  backendUrl: BACKEND_URL,
  frameless: true
}));

// ── lifecycle ─────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    initDataDir();
    initLogging();
    log(`userData: ${dataDirChoice}`);
    try {
      if (!DEV_VITE) {
        log("starting backend…");
        startBackend();
        await waitForBackend(30_000);
        log(`backend up on ${BACKEND_URL}`);
      }
      createWindow();
    } catch (error) {
      showError(
        "Не удалось запустить приложение",
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
      );
      app.exit(1);
    }
  });

  app.on("window-all-closed", () => {
    quitting = true;
    stopBackend();
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopBackend();
  });

  process.on("uncaughtException", (error) => {
    showError("Внутренняя ошибка приложения", error.stack ?? error.message);
  });
}
