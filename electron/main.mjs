import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { createParlorHandler } from "../server/parlor-api.mjs";

const NAME = "VayaView";
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";
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

/** On a Mac the program is VayaView.app/Contents/MacOS/VayaView; this is the VayaView.app folder. */
const appBundle = () => path.resolve(process.execPath, "..", "..", "..");

/**
 * Everything VayaView keeps (stations, backups, settings, library scan, even the window's own
 * cache) lives in one folder. On Windows it is beside the program: D:\SelfTV\Data next to
 * D:\SelfTV\VayaView. On a Mac a Data folder beside VayaView.app wins (a portable copy);
 * otherwise it is the usual Mac place, ~/Library/Application Support/VayaView/Data.
 */
function dataDir() {
  if (!app.isPackaged) return path.join(process.cwd(), "Data");
  if (!MAC) return path.resolve(path.dirname(process.execPath), "..", "Data");
  const beside = path.join(path.dirname(appBundle()), "Data");
  return fs.existsSync(beside) ? beside : path.join(os.homedir(), "Library", "Application Support", NAME, "Data");
}
const DATA_DIR = dataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath("userData", path.join(DATA_DIR, "app-cache"));
if (WIN) app.setAppUserModelId(APP_ID);

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
  pipeline(fs.createReadStream(file), res, () => {});
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
// New versions are published as GitHub releases with one zip of the program per system. Installing
// one replaces this copy where it stands (D:\SelfTV\VayaView, or VayaView.app), so there is only ever one VayaView.
const REPO = "CaptainSamus/VayaView";
const ASSET = MAC ? new RegExp(`^VayaView-darwin-${process.arch}\\.zip$`, "i") : /^VayaView-win32-x64\.zip$/i;
const update = { phase: "idle", progress: 0, error: null, notice: null };
const UPDATE_WORK = path.join(DATA_DIR, "temp-update");

/** Every step of an update goes in Data\update.log, so a failed one can be traced afterwards. */
function updateLog(line) {
  try {
    fs.appendFileSync(path.join(DATA_DIR, "update.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Nowhere to write; the update carries on.
  }
}

/** A path inside a single-quoted PowerShell string. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Data\temp-update is removed by the update itself once the new version has started. Still there at
 * start-up means the last update did not finish (or this is the new version, starting before the
 * script tidied up). Either way it is logged and removed; nothing else is touched.
 */
function tidyLeftoverUpdate() {
  if (!fs.existsSync(UPDATE_WORK)) return;
  let wanted = "";
  try {
    wanted = fs.readFileSync(path.join(UPDATE_WORK, "version.txt"), "utf8").trim();
  } catch {
    // Updates before this one did not write it.
  }
  const current = app.getVersion();
  if (wanted && wanted === current) {
    updateLog(`Start-up: ${current} is installed; removing the leftover temp-update folder.`);
  } else {
    // One started a moment ago may still be copying; leave it alone this time.
    if (Date.now() - fs.statSync(UPDATE_WORK).mtimeMs < 3 * 60_000) return updateLog("Start-up: an update looks to be under way; leaving temp-update alone.");
    updateLog(`Start-up: the last update${wanted ? ` (to ${wanted})` : ""} did not finish; still running ${current}. Removing temp-update.`);
    update.notice = `The last update${wanted ? ` (to ${wanted})` : ""} didn't finish, so this is still ${current}. You can try again.`;
  }
  fs.rm(UPDATE_WORK, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }, (error) => {
    if (error) updateLog(`Could not remove temp-update: ${error.message}`);
  });
}

/** "0.10.0" is newer than "0.9.2". */
function newer(candidate, current) {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

/**
 * GitHub allows 60 unsigned requests an hour from one internet connection, so the answer is
 * kept for ten minutes. Progress while updating comes from here, never from GitHub.
 */
let releaseCache = { at: 0, value: null };
async function latestRelease(fresh = false) {
  if (!fresh && Date.now() - releaseCache.at < 10 * 60_000) return releaseCache.value;
  const value = await fetchRelease();
  releaseCache = { at: Date.now(), value };
  return value;
}

async function fetchRelease() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "VayaView", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) throw new Error("GitHub is limiting checks for a while; try again within the hour");
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json();
  return {
    version: String(release.tag_name ?? "").replace(/^v/i, ""),
    notes: String(release.body ?? "").slice(0, 600),
    asset: (release.assets ?? []).find((asset) => ASSET.test(asset.name)) ?? null,
  };
}

async function checkUpdate(fresh = false) {
  const current = app.getVersion();
  // While downloading or installing, report progress without asking GitHub anything.
  if (update.phase !== "idle") return { supported: app.isPackaged, current, latest: releaseCache.value?.version ?? null, available: true, phase: update.phase, progress: update.progress, error: update.error, notice: update.notice };
  try {
    const release = await latestRelease(fresh);
    return {
      supported: app.isPackaged,
      current,
      latest: release?.version ?? null,
      available: Boolean(release?.asset && newer(release.version, current)),
      notes: release?.notes ?? "",
      phase: update.phase,
      progress: update.progress,
      error: update.error,
      notice: update.notice,
    };
  } catch (error) {
    return { supported: app.isPackaged, current, latest: null, available: false, phase: update.phase, error: `Could not reach GitHub (${error.message}).`, notice: update.notice };
  }
}

async function installUpdate() {
  if (!app.isPackaged || update.phase !== "idle") return;
  Object.assign(update, { phase: "downloading", progress: 0, error: null, notice: null });
  // A download that stops arriving for a minute is given up, instead of sitting at the same percent for ever.
  const control = new AbortController();
  let idle = null;
  const alive = () => {
    clearTimeout(idle);
    idle = setTimeout(() => control.abort(), 60_000);
  };
  let out = null;
  try {
    const release = await latestRelease(true);
    if (!release?.asset || !newer(release.version, app.getVersion())) throw new Error("No newer version to install.");
    updateLog(`Updating ${app.getVersion()} to ${release.version}.`);
    const work = UPDATE_WORK;
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    // Read at the next start-up, to tell a finished update from one that stopped halfway.
    fs.writeFileSync(path.join(work, "version.txt"), release.version);

    // Download, counting bytes for the progress bar.
    const zip = path.join(work, "VayaView.zip");
    alive();
    const response = await fetch(release.asset.browser_download_url, { headers: { "User-Agent": "VayaView" }, signal: control.signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const total = Number(response.headers.get("content-length")) || release.asset.size || 1;
    out = fs.createWriteStream(zip);
    let received = 0;
    for await (const chunk of response.body) {
      alive();
      received += chunk.length;
      update.progress = Math.min(1, received / total);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
    clearTimeout(idle);
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    updateLog(`Downloaded ${received} bytes.`);

    update.phase = "installing";
    if (MAC) {
      await finishMac(zip, work);
      setTimeout(() => app.quit(), 500);
      return;
    }
    const unpacked = path.join(work, "new");
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(unpacked)} -Force`], { windowsHide: true });
      child.on("error", () => reject(new Error("Could not start PowerShell to unpack the update.")));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Could not unpack the update."))));
    });
    updateLog("Unpacked.");
    // The zip holds the program's files, possibly inside one folder.
    const inner = fs.existsSync(path.join(unpacked, "VayaView.exe")) ? unpacked : path.join(unpacked, fs.readdirSync(unpacked)[0] ?? "");
    if (!fs.existsSync(path.join(inner, "VayaView.exe"))) throw new Error("The update did not contain VayaView.exe.");

    // A small script finishes the job once VayaView has closed: mirror the new files over this
    // copy (removing anything the new version no longer has), then start it again. Every step goes
    // in Data\update.log, with robocopy's own summary.
    const target = path.dirname(process.execPath);
    const script = path.join(work, "finish-update.ps1");
    fs.writeFileSync(
      script,
      [
        `$target = ${psQuote(target)}`,
        `$source = ${psQuote(inner)}`,
        `$work = ${psQuote(work)}`,
        `$log = ${psQuote(path.join(DATA_DIR, "update.log"))}`,
        "function Log($text) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' finish-update: ' + $text) -ErrorAction SilentlyContinue }",
        "try {",
        "  Log 'Started. Waiting for VayaView to close.'",
        "  $open = $true",
        "  for ($i = 0; $i -lt 120; $i++) { if (-not (Get-Process | Where-Object { $_.Path -like \"$target\\*\" })) { $open = $false; break }; Start-Sleep -Milliseconds 500 }",
        "  if ($open) { Log 'VayaView was still running after 60 seconds. Copying anyway.' } else { Log 'VayaView has closed. Copying the new files.' }",
        '  robocopy $source $target /MIR /R:10 /W:1 /NFL /NDL /NP "/LOG+:$log" | Out-Null',
        "  $code = $LASTEXITCODE",
        '  if ($code -lt 8) { Log "Copied (robocopy code $code)." } else { Log "Copy FAILED (robocopy code $code). See the robocopy lines above." }',
        "  Start-Process (Join-Path $target 'VayaView.exe')",
        "  Log 'Started VayaView.'",
        "  Start-Sleep -Seconds 5",
        "  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue",
        "  if (Test-Path -LiteralPath $work) { Log 'Could not remove temp-update yet; VayaView removes it at its next start.' } else { Log 'Removed temp-update. Done.' }",
        "} catch { Log ('Stopped by an error: ' + $_) }",
      ].join("\r\n"),
    );
    const finisher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // Close only once the script is really running; otherwise stay open and say what went wrong.
    await new Promise((resolve, reject) => {
      finisher.once("spawn", resolve);
      finisher.once("error", (error) => reject(new Error(`Could not start the update script (${error.message}).`)));
    });
    finisher.unref();
    updateLog("Started finish-update.ps1; closing VayaView.");
    setTimeout(() => app.quit(), 500);
  } catch (error) {
    clearTimeout(idle);
    out?.destroy();
    const message = control.signal.aborted ? "The download stopped arriving. Try again." : error.message;
    updateLog(`Update failed: ${message}`);
    Object.assign(update, { phase: "idle", progress: 0, error: message });
  }
}

/**
 * The Mac half of installing: unpack the new VayaView.app, then a small script waits for this one
 * to close, puts the new app where the old one was (removing the old, so there is one copy), and
 * opens it. If the swap fails, the old app is put back.
 */
async function finishMac(zip, work) {
  const bundle = appBundle();
  // A downloaded app that was never moved runs from a hidden, read-only copy and cannot be replaced.
  if (bundle.includes("/AppTranslocation/")) throw new Error("Move VayaView into your Applications folder first, then update.");
  const unpacked = path.join(work, "new");
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Could not unpack the update."))));
  });
  const fresh = path.join(unpacked, `${NAME}.app`);
  if (!fs.existsSync(path.join(fresh, "Contents", "MacOS", NAME))) throw new Error("The update did not contain VayaView.app.");
  const script = path.join(work, "finish-update.sh");
  // Paths arrive as arguments, so no quoting can break them: $1 pid, $2 old app, $3 new app, $4 work folder.
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      'i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 240 ]; do sleep 0.5; i=$((i+1)); done',
      'xattr -dr com.apple.quarantine "$3" 2>/dev/null',
      'rm -rf "$2.old"',
      'if mv "$2" "$2.old" && ditto "$3" "$2"; then rm -rf "$2.old"; else rm -rf "$2"; mv "$2.old" "$2"; fi',
      'open "$2"',
      'sleep 5; rm -rf "$4"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  spawn("/bin/sh", [script, String(process.pid), bundle, fresh, work], { detached: true, stdio: "ignore" }).unref();
}

/** The folder chooser, for the library and the downloads folder. PC only (see handler.remote). */
async function pickFolder(win, title, defaultPath) {
  const result = await dialog.showOpenDialog(win, { title, defaultPath, properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let phoneServer = null;
  const api = createParlorHandler({
    dataDir: DATA_DIR,
    onPhone: setPhone,
    update: { check: checkUpdate, install: installUpdate },
    pickFolder: (title, defaultPath) => pickFolder(win, title, defaultPath),
  });

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
    if (app.isPackaged) tidyLeftoverUpdate();
    if (app.isPackaged && WIN) {
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
    // Windows has no menu bar. A Mac always has one, and without Edit, Cmd+C/V do nothing in text boxes.
    Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
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
    if (app.isPackaged && WIN) {
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
