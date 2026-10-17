// Zips the packaged app into releases/: the files a GitHub release carries, and the ones the
// in-app updater downloads. Run after `npm run package` (or use `npm run release`).
//   Windows: releases\VayaView-win32-x64.zip (Compress-Archive).
//   Mac:     releases/VayaView-darwin-arm64.zip and -x64.zip, each ad-hoc signed first and zipped
//            with ditto, which keeps the symlinks and permissions inside the app bundle.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const releases = path.resolve("releases");
fs.mkdirSync(releases, { recursive: true });

const report = (out) => console.log(`Release zip for v${version}: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);

if (process.platform === "darwin") {
  for (const arch of ["arm64", "x64"]) {
    const app = path.join(releases, "mac", `VayaView-darwin-${arch}`, "VayaView.app");
    if (!fs.existsSync(app)) {
      console.log(`No ${arch} app at ${app}; skipping. Build it with: npm run package`);
      continue;
    }
    const out = path.join(releases, `VayaView-darwin-${arch}.zip`);
    fs.rmSync(out, { force: true });
    // There is no Apple Developer account, so the app is ad-hoc signed only (first open: right-click > Open).
    execFileSync("codesign", ["--force", "--deep", "-s", "-", app], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", app], { stdio: "inherit" });
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, out], { stdio: "inherit" });
    report(out);
  }
} else {
  // Zips the staged build when there is one, otherwise the installed copy.
  const source = fs.existsSync(path.resolve("releases", "VayaView", "VayaView.exe")) ? path.resolve("releases", "VayaView") : path.resolve("VayaView");
  const out = path.join(releases, "VayaView-win32-x64.zip");
  fs.rmSync(out, { force: true });
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${source}\\*' -DestinationPath '${out}' -CompressionLevel Optimal`], { stdio: "inherit" });
  report(out);
}
