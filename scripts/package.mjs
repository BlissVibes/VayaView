// Builds D:\SelfTV\VayaView\VayaView.exe and clears every older copy. Run with: npm run package
// The app's saved data is in D:\SelfTV\Data and is never touched here.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packager } from "@electron/packager";

const keep = ["electron", "server", "dist-web", "package.json"];
const target = path.resolve("VayaView");

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
  // Only the shell, the backend, and the built UI ship. Everything is bundled, so no node_modules.
  ignore: (file) => file !== "" && !keep.some((name) => file === `/${name}` || file.startsWith(`/${name}/`)),
});

// One copy of the program, always in the same place: the new build replaces the old one,
// and every older build (from when it was called Parlor) is removed.
for (const old of [target, path.resolve("app"), path.resolve("release")]) fs.rmSync(old, { recursive: true, force: true });
fs.cpSync(built, target, { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Packaged: ${path.join(target, "VayaView.exe")} (icon ${iconName})`);
