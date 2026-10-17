// Builds the app for the system this runs on. Run with: npm run package
//   Windows: D:\SelfTV\VayaView\VayaView.exe, clearing every older copy.
//   Mac:     releases/mac/VayaView-darwin-{arm64,x64}/VayaView.app (the same as --mac).
// Pass --win on a Mac to cross-build the Windows exe instead (needs Wine for the icon).
// The app's saved data (D:\SelfTV\Data, ~/Library/Application Support/VayaView/Data) is never touched here.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packager } from "@electron/packager";

// The app ships a TMDB token so nobody has to make an account for genres. It comes from
// server/tmdb-key.json, or is written there now from VAYAVIEW_TMDB_TOKEN (the Mac workflow's secret).
const keyFile = path.resolve("server", "tmdb-key.json");
if (!fs.existsSync(keyFile) && (process.env.VAYAVIEW_TMDB_TOKEN ?? "").trim()) fs.writeFileSync(keyFile, JSON.stringify({ token: process.env.VAYAVIEW_TMDB_TOKEN.trim() }));
if (!fs.existsSync(keyFile)) console.warn("No TMDB token packaged (server/tmdb-key.json or VAYAVIEW_TMDB_TOKEN). Users will need to paste their own under Settings.");

const keep = ["electron", "server", "dist-web", "package.json"];
// Only the shell, the backend, and the built UI ship. Everything is bundled, so no node_modules.
// Each build also leaves out the other system's icon file.
const shipOnly = (otherIcon) => (file) => file !== "" && (file.endsWith(otherIcon) || !keep.some((name) => file === `/${name}` || file.startsWith(`/${name}/`)));

// --mac builds VayaView.app for Apple Silicon and Intel into releases\mac. It must run on a Mac:
// the app has to be signed there, and its framework is full of symlinks Windows cannot make.
// GitHub does it for each release (.github/workflows/mac-release.yml).
const buildMac = process.argv.includes("--mac") || (process.platform === "darwin" && !process.argv.includes("--win"));
if (buildMac) {
  if (process.platform !== "darwin") throw new Error("Build the Mac app on a Mac (or let the mac-release workflow do it).");
  const out = path.resolve("releases", "mac");
  fs.rmSync(out, { recursive: true, force: true });
  const built = await packager({
    dir: ".",
    name: "VayaView",
    platform: "darwin",
    arch: ["arm64", "x64"],
    out,
    overwrite: true,
    icon: "electron/icon.icns",
    appBundleId: "tv.vayaview.app",
    appCategoryType: "public.app-category.entertainment",
    extendInfo: { NSLocalNetworkUsageDescription: "VayaView can stream to your phone over home Wi-Fi when Phone access is on." },
    prune: true,
    ignore: shipOnly(".ico"),
  });
  for (const dir of built) console.log(`Packaged: ${path.join(dir, "VayaView.app")}`);
  process.exit(0);
}

// --staging builds into releases\VayaView without touching the installed copy (it may be open).
const staged = process.argv.includes("--staging");
const target = staged ? path.resolve("releases", "VayaView") : path.resolve("VayaView");

// Windows remembers an icon by the file it came from. Naming the icon file after its own
// contents means a new picture is a new file name, so Windows has nothing stale to show.
const icon = fs.readFileSync("electron/icon.ico");
const iconName = `vayaview-icon-${crypto.createHash("sha1").update(icon).digest("hex").slice(0, 8)}.ico`;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vayaview-build-"));
fs.copyFileSync("electron/icon.ico", path.join(staging, iconName));

const [built] = await packager({
  dir: ".",
  name: "VayaView",
  platform: "win32",
  arch: "x64",
  out: staging,
  overwrite: true,
  icon: "electron/icon.ico",
  // A real file beside the exe (not inside the app archive) for taskbar pins and shortcuts to point at.
  extraResource: [path.join(staging, iconName)],
  prune: true,
  ignore: shipOnly(".icns"),
});

// One copy of the program, always in the same place: the new build replaces the old one,
// and every older build (from when it was called Parlor) is removed.
for (const old of staged ? [target] : [target, path.resolve("app"), path.resolve("release")]) fs.rmSync(old, { recursive: true, force: true });
fs.cpSync(built, target, { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Packaged: ${path.join(target, "VayaView.exe")} (icon ${iconName})`);
