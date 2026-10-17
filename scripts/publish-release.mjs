// Publishes every releases/VayaView-*.zip (Windows and/or Mac, whichever this machine built) as a
// GitHub release for the version in package.json.
// Uses the GitHub sign-in git already has saved (git credential fill), or the gh CLI's token on a
// Mac. The token is held in memory for these requests only: never printed, never written to a file.
// Run with: node scripts/publish-release.mjs "What changed in this version"
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "CaptainSamus/VayaView";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
const releases = path.resolve("releases");
const zips = fs.existsSync(releases) ? fs.readdirSync(releases).filter((name) => /^VayaView-(win32|darwin)-[a-z0-9]+\.zip$/.test(name)).map((name) => path.join(releases, name)) : [];
const notes = process.argv[2] ?? `VayaView ${version}`;
if (zips.length === 0) throw new Error("Build the zip first: npm run release");

function findToken() {
  try {
    const credential = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const saved = /^password=(.+)$/m.exec(credential)?.[1]?.trim();
    if (saved) return saved;
  } catch {
    // No saved sign-in; try gh.
  }
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
const token = findToken();
if (!token) throw new Error("No GitHub sign-in found: sign in with git, or run `gh auth login`.");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "VayaView-release" };

async function api(method, url, body) {
  const response = await fetch(url, { method, headers: { ...headers, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url.replace(/\?.*/, "")} → ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Reuse the release if this version was already started, otherwise create it.
let release;
try {
  release = await api("GET", `https://api.github.com/repos/${REPO}/releases/tags/${tag}`);
} catch {
  release = await api("POST", `https://api.github.com/repos/${REPO}/releases`, { tag_name: tag, target_commitish: "main", name: `VayaView ${version}`, body: notes, draft: false, prerelease: false });
}
console.log(`Published ${tag}: ${release.html_url}`);
for (const zip of zips) {
  // One zip of each kind per release: replace an earlier upload of it.
  for (const asset of release.assets ?? []) if (asset.name === path.basename(zip)) await api("DELETE", asset.url);
  const upload = release.upload_url.replace(/\{.*\}$/, "") + `?name=${encodeURIComponent(path.basename(zip))}`;
  const data = fs.readFileSync(zip);
  const response = await fetch(upload, { method: "POST", headers: { ...headers, "Content-Type": "application/zip", "Content-Length": String(data.length) }, body: data });
  if (!response.ok) throw new Error(`Upload failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const asset = await response.json();
  console.log(`Asset: ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB) ${asset.browser_download_url}`);
}
