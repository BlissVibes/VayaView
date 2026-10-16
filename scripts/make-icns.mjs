// Builds electron/icon.icns (the Mac icon) from electron/icon.png, keeping its transparency.
// Run after make-icon.mjs whenever the picture changes: node scripts/make-icns.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// An .icns is a list of [4-letter type, length, PNG]. macOS picks the size it needs; the
// @2x types are the same pixels for sharp screens. 512 is the largest the source allows.
const types = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic13", 256],
  ["ic09", 512],
  ["ic14", 512],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vayaview-icns-"));
const pngs = new Map();
const chunks = types.map(([type, size]) => {
  if (!pngs.has(size)) {
    const file = path.join(tmp, `${size}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", "electron/icon.png", "-vf", `format=rgba,scale=${size}:${size}:flags=lanczos,format=rgba`, "-pix_fmt", "rgba", file]);
    pngs.set(size, fs.readFileSync(file));
  }
  const data = pngs.get(size);
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync("electron/icon.icns", Buffer.concat([header, body]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`icon.icns (${types.map(([type, size]) => `${type} ${size}`).join(", ")})`);
