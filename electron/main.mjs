import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, Menu, shell } from "electron";
import { createParlorHandler } from "../server/parlor-api.mjs";

const NAME = "VayaView";
/** Windows groups taskbar buttons, and picks their icon, by this id. */
const APP_ID = "VayaView.TV";
/** Fixed, so the window always opens on the same page. Loopback only. */
const PORT = 47816;
const WEB_ROOT = path.join(import.meta.dirname, "..", "dist-web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * Everything VayaView keeps (stations, backups, settings, library scan, even the window's own
 * cache) lives in one folder beside the program: D:\SelfTV\Data next to D:\SelfTV\VayaView.
 */
const DATA_DIR = app.isPackaged ? path.resolve(path.dirname(process.execPath), "..", "Data") : path.join(process.cwd(), "Data");
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath("userData", path.join(DATA_DIR, "app-cache"));
app.setAppUserModelId(APP_ID);

// A background hiccup (a stream folder that would not delete, a dropped connection) must not
// put an error box in front of the picture. It goes in a log in the Data folder instead.
process.on("uncaughtException", (error) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "errors.log"), `${new Date().toISOString()} ${error?.stack ?? error}\n`);
  } catch {
    // Nowhere to write; carry on.
  }
});

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  let file = path.join(WEB_ROOT, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_ROOT, "index.html");
  }
  res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}

/** The icon file shipped beside the program (its name changes with the picture, so Windows never shows a stale one). */
function iconFile() {
  if (!app.isPackaged) return path.join(import.meta.dirname, "icon.ico");
  const name = fs.readdirSync(process.resourcesPath).find((file) => /^(vayaview|parlor)-icon-.*\.ico$/.test(file));
  return path.join(process.resourcesPath, name ?? "icon.ico");
}

/**
 * Older homes of this program's data (from when it was called Parlor) are folded into
 * Data\old-copies once, then removed from where they were. Only saved data is kept;
 * browser caches are not worth copying.
 */
function tidyOldCopies() {
  const old = [
    [path.join(os.homedir(), "Parlor Data"), "Parlor Data (C drive)"],
    [path.join(app.getPath("appData"), "Parlor"), "Parlor (AppData)"],
  ];
  for (const [dir, label] of old) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.cpSync(dir, path.join(DATA_DIR, "old-copies", label), {
        recursive: true,
        filter: (source) => source === dir || /[\\/](store|store-dev|backups)([\\/]|$)|parlor-[\w-]+\.(json|log)$/.test(source),
      });
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // In use or locked: try again next start.
    }
  }
}

/** A Start menu entry that carries this app's id and icon, so pinning it shows the right picture. Old Parlor entries go. */
function placeShortcuts() {
  const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  for (const dir of [programs, app.getPath("desktop")]) {
    try {
      fs.rmSync(path.join(dir, "Parlor.lnk"), { force: true });
    } catch {
      // Not there.
    }
  }
  const link = path.join(programs, `${NAME}.lnk`);
  shell.writeShortcutLink(link, fs.existsSync(link) ? "replace" : "create", {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    icon: iconFile(),
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: NAME,
  });
}

// ---------------------------------------------------------------- Updates
// New versions are published as GitHub releases with one zip of the program. Installing one
// replaces this copy where it stands (D:\SelfTV\VayaView), so there is only ever one VayaView.
const REPO = "CaptainSamus/VayaView";
const ASSET = /^VayaView-win32-x64\.zip$/i;
const update = { phase: "idle", progress: 0, error: null };

/** "0.10.0" is newer than "0.9.2". */
function newer(candidate, current) {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "VayaView", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json();
  return {
    version: String(release.tag_name ?? "").replace(/^v/i, ""),
    notes: String(release.body ?? "").slice(0, 600),
    asset: (release.assets ?? []).find((asset) => ASSET.test(asset.name)) ?? null,
  };
}

async function checkUpdate() {
  const current = app.getVersion();
  try {
    const release = await latestRelease();
    return {
      supported: app.isPackaged,
      current,
      latest: release?.version ?? null,
      available: Boolean(release?.asset && newer(release.version, current)),
      notes: release?.notes ?? "",
      phase: update.phase,
      progress: update.progress,
      error: update.error,
    };
  } catch (error) {
    return { supported: app.isPackaged, current, latest: null, available: false, phase: update.phase, error: `Could not reach GitHub (${error.message}).` };
  }
}

async function installUpdate() {
  if (!app.isPackaged || update.phase !== "idle") return;
  Object.assign(update, { phase: "downloading", progress: 0, error: null });
  try {
    const release = await latestRelease();
    if (!release?.asset || !newer(release.version, app.getVersion())) throw new Error("No newer version to install.");
    const work = path.join(DATA_DIR, "temp-update");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });

    // Download, counting bytes for the progress bar.
    const zip = path.join(work, "VayaView.zip");
    const response = await fetch(release.asset.browser_download_url, { headers: { "User-Agent": "VayaView" } });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const total = Number(response.headers.get("content-length")) || release.asset.size || 1;
    const out = fs.createWriteStream(zip);
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      update.progress = Math.min(1, received / total);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));

    update.phase = "installing";
    const unpacked = path.join(work, "new");
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpacked}' -Force`], { windowsHide: true });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Could not unpack the update."))));
    });
    // The zip holds the program's files, possibly inside one folder.
    const inner = fs.existsSync(path.join(unpacked, "VayaView.exe")) ? unpacked : path.join(unpacked, fs.readdirSync(unpacked)[0] ?? "");
    if (!fs.existsSync(path.join(inner, "VayaView.exe"))) throw new Error("The update did not contain VayaView.exe.");

    // A small script finishes the job once VayaView has closed: mirror the new files over this
    // copy (removing anything the new version no longer has), then start it again.
    const target = path.dirname(process.execPath);
    const script = path.join(work, "finish-update.ps1");
    fs.writeFileSync(
      script,
      [
        `$target = '${target}'`,
        `$source = '${inner}'`,
        "for ($i = 0; $i -lt 120; $i++) { if (-not (Get-Process | Where-Object { $_.Path -like \"$target\\*\" })) { break }; Start-Sleep -Milliseconds 500 }",
        'robocopy $source $target /MIR /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
        'Start-Process (Join-Path $target "VayaView.exe")',
        `Start-Sleep -Seconds 5; Remove-Item -LiteralPath '${work}' -Recurse -Force -ErrorAction SilentlyContinue`,
      ].join("\r\n"),
    );
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    setTimeout(() => app.quit(), 500);
  } catch (error) {
    Object.assign(update, { phase: "idle", progress: 0, error: error.message });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let phoneServer = null;
  const api = createParlorHandler({ dataDir: DATA_DIR, onPhone: setPhone, update: { check: checkUpdate, install: installUpdate } });

  /** Listen on the home network only while Phone access is on. Off means nothing is listening. */
  async function setPhone(enabled) {
    if (enabled && !phoneServer) {
      const server = http.createServer((req, res) => api.remote(req, res, () => serveStatic(req, res)));
      await new Promise((resolve) => {
        server.once("error", resolve);
        server.listen(api.phonePort, "0.0.0.0", resolve);
      });
      phoneServer = server.listening ? server : null;
    } else if (!enabled && phoneServer) {
      phoneServer.closeAllConnections?.();
      phoneServer.close();
      phoneServer = null;
    }
  }

  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    if (app.isPackaged) {
      tidyOldCopies();
      try {
        placeShortcuts();
      } catch {
        // A missing shortcut is not worth stopping for.
      }
    }
    const server = http.createServer((req, res) => api(req, res, () => serveStatic(req, res)));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, "127.0.0.1", resolve);
    });
    if (api.phoneEnabled()) await setPhone(true);
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      backgroundColor: "#12100e",
      title: NAME,
      icon: path.join(import.meta.dirname, "icon.png"),
      webPreferences: { autoplayPolicy: "no-user-gesture-required" },
    });
    win.on("closed", () => (win = null));
    // What a taskbar pin records: this id, this exe to relaunch, and this icon.
    if (app.isPackaged) {
      win.setAppDetails({
        appId: APP_ID,
        appIconPath: iconFile(),
        appIconIndex: 0,
        relaunchCommand: `"${process.execPath}"`,
        relaunchDisplayName: NAME,
      });
    }
    // A stations backup asks where to go, starting in the backups folder.
    win.webContents.session.on("will-download", (_event, item) => {
      item.setSaveDialogOptions({ title: "Save stations backup", defaultPath: path.join(DATA_DIR, "backups", item.getFilename()) });
    });
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
  });

  app.on("before-quit", () => {
    api.snapshot("closed");
    api.dispose();
  });
  app.on("window-all-closed", () => app.quit());
}
