// Zips D:\SelfTV\VayaView into releases\VayaView-win32-x64.zip: the one file a GitHub release
// carries, and the one the in-app updater downloads. Run after `npm run package` (or use `npm run release`).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
// Zips the staged build when there is one, otherwise the installed copy.
const source = fs.existsSync(path.resolve("releases", "VayaView", "VayaView.exe")) ? path.resolve("releases", "VayaView") : path.resolve("VayaView");
const out = path.resolve("releases", "VayaView-win32-x64.zip");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${source}\\*' -DestinationPath '${out}' -CompressionLevel Optimal`], { stdio: "inherit" });
console.log(`Release zip for v${version}: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
