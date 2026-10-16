// Builds electron/icon.png and a multi-size electron/icon.ico from a source picture, keeping its transparency.
// Usage: node scripts/make-icon.mjs <source image> <crop w:h:x:y>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [source, crop] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parlor-icon-"));
const png = (size, out) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", source, "-vf", `format=rgba,crop=${crop},scale=${size}:${size}:flags=lanczos,format=rgba`, "-pix_fmt", "rgba", out]);

png(512, "electron/icon.png");

// An .ico is a small directory of images. Windows picks the size it needs, so give it every common one.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => {
  const file = path.join(tmp, `${size}.png`);
  png(size, file);
  return fs.readFileSync(file);
});
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  header.writeUInt8(size === 256 ? 0 : size, at);
  header.writeUInt8(size === 256 ? 0 : size, at + 1);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(images[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
fs.writeFileSync("electron/icon.ico", Buffer.concat([header, ...images]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`icon.png + icon.ico (${sizes.join(", ")})`);
