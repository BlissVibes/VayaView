/**
 * Local library + player backend. One handler, used by the packaged app
 * (electron/main.mjs) and by the Vite dev server.
 *
 *   GET  /api/library            scan the folders, probe new files once
 *   GET  /api/status             scan progress
 *   POST /api/config             { folders: string[] }
 *   GET  /api/keyframe/:id?t=    keyframe at or before t, so a copy session knows where it began
 *   GET  /media/:id              the file itself, with Range (direct play)
 *   GET  /media/:id?t=&a=&v=     one ffmpeg session from that offset. Dies when the viewer leaves.
 *   GET  /subs/:id?s=&t=         one subtitle track as WebVTT from that offset (copied out of the film once, then cached)
 *
 * Schedule math is not in here. See src/lib/schedule/engine.ts.
 */
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import { createYoutube } from "./youtube.mjs";

const VIDEO_EXT = new Set([".mp4", ".m4v", ".mkv", ".mov", ".webm", ".avi", ".wmv", ".mpg", ".mpeg", ".m2ts", ".flv"]);
const SUB_EXT = new Set([".srt", ".vtt", ".ass", ".ssa"]);
const DIRECT_EXT = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);
const DIRECT_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const DIRECT_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const TEXT_SUBS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);
const MIME = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm", ".mkv": "video/webm" };
/** The library on the PC this was made for. Elsewhere there is none until one is picked. */
const DEFAULT_FOLDER = process.platform === "win32" ? "G:\\MOVIES" : null;
/** Bump when the probe stores something new, so old entries are measured again. */
const CACHE_VERSION = 3;

/**
 * Where ffmpeg and ffprobe are. A Mac app opened from Finder does not get the Terminal's PATH,
 * so Homebrew's folders are tried by name. On Windows the bare name has always worked.
 */
function findTool(name) {
  if (process.platform === "win32") return name;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  for (const dir of dirs) {
    const file = dir && path.join(dir, name);
    try {
      if (file) {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      }
    } catch {
      // Not here.
    }
  }
  return name;
}
const FFMPEG = findTool("ffmpeg");
const FFPROBE = findTool("ffprobe");

/** "~/Movies" means the home folder's Movies, as it does in a Mac or Linux shell. */
const expandHome = (dir) => (dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir);

export function createParlorHandler(options = {}) {
  // Everything VayaView keeps lives in one Data folder beside the program (D:\SelfTV\Data). Not in
  // AppData: Windows can give a program a private copy of AppData depending on what started it,
  // and then the same app saves to two places.
  const dataDir = options.dataDir ?? path.join(process.cwd(), "Data");
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(dataDir, "parlor-config.json");
  const cacheFile = path.join(dataDir, "parlor-library.json");
  const episodesFile = path.join(dataDir, "parlor-episodes.json");
  // The dev server keeps its own store and its own backups, so testing never touches the real app's stations or copies.
  const storeDir = path.join(dataDir, options.store ?? "store");
  const backupDir = path.join(dataDir, options.store && options.store !== "store" ? `${options.store}-backups` : "backups");
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  /** id -> entry, rebuilt on every scan. /media only serves what is in here. */
  let index = new Map();
  let scanning = null;
  /** The last finished scan. A window (or phone) opening within ten minutes is handed this instead of a new walk of every folder. */
  let lastScan = null;
  let ffprobeOk = true;
  let encoderArgs = null;
  const status = { phase: "idle", done: 0, total: 0 };
  const children = new Set();

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  function folders() {
    const config = readJson(configFile, null);
    if (config && Array.isArray(config.folders)) return config.folders.filter((item) => typeof item === "string");
    return DEFAULT_FOLDER && fs.existsSync(DEFAULT_FOLDER) ? [DEFAULT_FOLDER] : [];
  }

  /** Collects videos, and the subtitle files sitting in each folder. */
  async function walk(dir, videos, subsByDir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("$") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      if (entry.isDirectory()) await walk(full, videos, subsByDir);
      else if (VIDEO_EXT.has(ext)) videos.push(full);
      else if (SUB_EXT.has(ext)) subsByDir.set(dir, [...(subsByDir.get(dir) ?? []), full]);
    }
  }

  /** Duration, codecs, audio and subtitle tracks. The only heavy step, once per file. */
  function probe(file) {
    return new Promise((resolve) => {
      execFile(
        FFPROBE,
        ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,channels,width,height:stream_tags=language,title", "-of", "json", file],
        { timeout: 45_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            if (error.code === "ENOENT") ffprobeOk = false;
            return resolve(null);
          }
          try {
            const data = JSON.parse(stdout);
            const streams = data.streams ?? [];
            const video = streams.find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
            const track = (s) => ({ codec: s.codec_name ?? "", lang: s.tags?.language ?? "", title: s.tags?.title ?? "" });
            resolve({
              durationMs: Math.round(Number(data.format?.duration ?? 0) * 1000) || 0,
              vcodec: video?.codec_name ?? null,
              width: video?.width ?? 0,
              height: video?.height ?? 0,
              audio: streams.filter((s) => s.codec_type === "audio").map((s) => ({ ...track(s), ch: s.channels ?? 0 })),
              subs: streams.filter((s) => s.codec_type === "subtitle").map(track),
            });
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  async function pool(items, size, worker) {
    let next = 0;
    await Promise.all(
      Array.from({ length: size }, async () => {
        while (next < items.length) await worker(items[next++]);
      }),
    );
  }

  /** Subtitle files that belong to this video: same name, or the only video in its folder. */
  function sidecarsFor(file, videosInDir, subsByDir) {
    const dir = path.dirname(file);
    const stem = path.basename(file, path.extname(file)).toLowerCase();
    const alone = videosInDir.get(dir) === 1;
    const near = [...(subsByDir.get(dir) ?? [])];
    if (alone) for (const name of ["Subs", "Subtitles", "subs"]) near.push(...(subsByDir.get(path.join(dir, name)) ?? []));
    return [...new Set(near)]
      .filter((sub) => alone || path.basename(sub).toLowerCase().startsWith(stem))
      .slice(0, 12)
      .map((sub) => {
        const name = path.basename(sub, path.extname(sub));
        const label = (name.toLowerCase().startsWith(stem) ? name.slice(stem.length) : name).replace(/^[\d._\-\s]+/, "").trim();
        const lang = /^(en|eng|english)\b/i.test(label) ? "eng" : label.toLowerCase();
        return { file: sub, title: label || "External", lang };
      });
  }

  async function scan() {
    const roots = folders();
    const cached = readJson(cacheFile, {});
    const cache = cached.version === CACHE_VERSION ? (cached.files ?? {}) : {};
    const found = [];
    const subsByDir = new Map();

    status.phase = "walking";
    status.done = 0;
    status.total = 0;
    for (const root of roots) {
      const videos = [];
      await walk(root, videos, subsByDir);
      for (const file of videos) found.push({ root, file });
    }

    const stale = [];
    const seen = new Set();
    await pool(found, 16, async (item) => {
      let stat;
      try {
        stat = await fsp.stat(item.file);
      } catch {
        return;
      }
      seen.add(item.file);
      const hit = cache[item.file];
      if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) hit.root = item.root;
      else stale.push({ ...item, size: stat.size, mtimeMs: stat.mtimeMs });
    });

    status.phase = "probing";
    status.total = stale.length;
    let unsaved = 0;
    await pool(stale, 6, async (item) => {
      const info = await probe(item.file);
      status.done += 1;
      if (!info) return;
      cache[item.file] = { root: item.root, size: item.size, mtimeMs: item.mtimeMs, ...info };
      // A long first scan survives the app being closed halfway.
      if (++unsaved % 100 === 0) fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, files: cache }));
    });

    const videosInDir = new Map();
    for (const file of seen) videosInDir.set(path.dirname(file), (videosInDir.get(path.dirname(file)) ?? 0) + 1);

    const films = [];
    index = new Map();
    for (const [file, entry] of Object.entries(cache)) {
      if (!roots.includes(entry.root)) {
        delete cache[file];
        continue;
      }
      if (!entry.durationMs || !entry.vcodec) continue;
      const ext = path.extname(file).toLowerCase();
      const id = crypto.createHash("sha1").update(file.toLowerCase()).digest("hex").slice(0, 12);
      // A file that vanished keeps its slot and its runtime. The station does not skip.
      const missing = !seen.has(file);
      const first = entry.audio[0]?.codec;
      const direct = DIRECT_EXT.has(ext) && DIRECT_VIDEO.has(entry.vcodec) && (!first || DIRECT_AUDIO.has(first));
      const sidecars = missing ? [] : sidecarsFor(file, videosInDir, subsByDir);
      index.set(id, { file, ext, vcodec: entry.vcodec, width: entry.width ?? 0, height: entry.height ?? 0, sidecars: sidecars.map((sub) => sub.file) });
      films.push({
        id,
        path: file,
        rel: path.relative(entry.root, file),
        durationMs: entry.durationMs,
        vcodec: entry.vcodec,
        width: entry.width ?? 0,
        height: entry.height ?? 0,
        size: entry.size,
        direct,
        missing,
        audio: entry.audio,
        subs: [
          ...entry.subs.map((sub, i) => ({ key: String(i), lang: sub.lang, title: sub.title, text: TEXT_SUBS.has(sub.codec) })),
          ...sidecars.map((sub, i) => ({ key: `x${i}`, lang: sub.lang, title: sub.title, text: true })),
        ],
      });
    }
    films.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, files: cache }));
    status.phase = "idle";
    const result = { folders: roots, films, ffprobe: ffprobeOk, platform: process.platform };
    lastScan = { at: Date.now(), result };
    return result;
  }

  /** True when ffmpeg can really encode with these settings on this machine. */
  const works = (args) =>
    new Promise((resolve) =>
      execFile(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.2", ...args, "-f", "null", "-"], { timeout: 10_000, windowsHide: true }, (error) => resolve(!error)),
    );

  /** A failed hardware test is tried again after this long: a GPU busy at start-up should not mean the slow way all day. */
  const RETEST_MS = 3 * 60_000;

  /**
   * Hardware encoder when the machine really has one. Tested once per kind, or again a few minutes
   * after a failure. No B-frames, so picture and sound both start at zero. NVIDIA on the PC; on a
   * Mac, Apple's own (VideoToolbox), and for the iPhone stream HEVC, which the phone plays natively
   * at half the size.
   */
  function encoder(kind = "file") {
    encoderArgs ??= new Map();
    const tested = encoderArgs.get(kind);
    if (tested && !(tested.fallback && Date.now() - tested.at > RETEST_MS)) return tested.args;
    const nvenc = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-bf", "0", "-pix_fmt", "yuv420p"];
    const vtH264 = ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-maxrate", "12M", "-bufsize", "16M", "-realtime", "1", "-bf", "0", "-pix_fmt", "yuv420p"];
    const vtHevc = ["-c:v", "hevc_videotoolbox", "-b:v", "5M", "-maxrate", "8M", "-bufsize", "10M", "-realtime", "1", "-bf", "0", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"];
    const x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-bf", "0", "-pix_fmt", "yuv420p"];
    const tries = process.platform === "darwin" ? (kind === "hls" ? [vtHevc, vtH264] : [vtH264]) : [nvenc];
    const test = { at: Date.now(), fallback: false, args: null };
    test.args = (async () => {
      for (const args of tries) if (await works(args)) return args;
      test.fallback = true;
      return x264;
    })();
    encoderArgs.set(kind, test);
    return test.args;
  }

  /**
   * With NVENC, the NVIDIA card decodes too, so the processor no longer unpacks 4K HEVC frame by
   * frame. ffmpeg falls back to the processor by itself for a format the card cannot decode.
   */
  let cudaTest = null;
  async function decoder(encode) {
    if (!encode.includes("h264_nvenc")) return [];
    if (!cudaTest || (cudaTest.failed && Date.now() - cudaTest.at > RETEST_MS)) {
      const test = { at: Date.now(), failed: false, ok: null };
      test.ok = new Promise((resolve) =>
        execFile(FFMPEG, ["-v", "error", "-init_hw_device", "cuda", "-f", "lavfi", "-i", "color=s=64x64:d=0.1", "-f", "null", "-"], { timeout: 10_000, windowsHide: true }, (error) => {
          test.failed = Boolean(error);
          resolve(!error);
        }),
      );
      cudaTest = test;
    }
    return (await cudaTest.ok) ? ["-hwaccel", "cuda"] : [];
  }

  /**
   * The picture, at most 1080 lines, with a picture-based subtitle burned in. The picture is made
   * smaller first and the subtitle scaled by the same amount, so the overlay works on the small
   * frame instead of the 4K one; it lands exactly where it did before.
   */
  function burnFilter(entry, burn) {
    if (!entry.width || !entry.height || entry.height <= 1080) return `[0:v:0][0:s:${burn}]overlay,scale=-2:'min(1080,ih)'[v]`;
    const factor = (1080 / entry.height).toFixed(6);
    return `[0:v:0]scale=-2:1080[base];[0:s:${burn}]scale='trunc(iw*${factor}/2)*2':'trunc(ih*${factor}/2)*2'[sub];[base][sub]overlay[v]`;
  }

  function run(command, args, res) {
    // The viewer may have left while the encoder was being chosen. Start nothing for nobody.
    if (res.destroyed) return;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    children.add(child);
    child.stdout.pipe(res);
    child.on("error", () => res.destroy());
    child.on("exit", () => children.delete(child));
    res.on("close", () => child.kill());
    return child;
  }

  /**
   * Encodes running on the NVIDIA card, oldest first. A GeForce card takes only a handful at once,
   * and fast flipping can leave old ones finishing; past six, the oldest is stopped to make room.
   */
  const MAX_NVENC = 6;
  const nvencRunning = [];
  function nvencRoom() {
    while (nvencRunning.length >= MAX_NVENC) nvencRunning.shift().stop();
  }
  function nvencAdd(child, stop) {
    if (!child) return;
    const item = { child, stop };
    nvencRunning.push(item);
    const done = () => {
      const at = nvencRunning.indexOf(item);
      if (at >= 0) nvencRunning.splice(at, 1);
    };
    child.once("exit", done);
    child.once("error", done);
  }
  const usesNvenc = (encode) => Boolean(encode?.includes("h264_nvenc"));

  function sendJson(res, code, body) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
  }

  function sendDirect(req, res, entry) {
    let stat;
    try {
      stat = fs.statSync(entry.file);
    } catch {
      res.statusCode = 404;
      return res.end();
    }
    const match = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    let start = 0;
    let end = stat.size - 1;
    if (match) {
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
      if (start > end) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${stat.size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", MIME[entry.ext] ?? "application/octet-stream");
    res.setHeader("Content-Length", end - start + 1);
    const stream = fs.createReadStream(entry.file, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  /**
   * One session for the one screen that is watching. Never a standing encode.
   * v=copy keeps the picture untouched and only converts the sound. v=enc
   * re-encodes, which is the only way to burn in picture-based subtitles.
   */
  async function sendSession(res, entry, query) {
    const t = Math.max(0, Number(query.get("t")) || 0);
    const audio = Math.max(0, parseInt(query.get("a") ?? "0", 10) || 0);
    const burn = query.get("burn") == null ? null : Math.max(0, parseInt(query.get("burn"), 10) || 0);
    const copy = query.get("v") === "copy" && burn == null;
    // A copied picture can only begin on a keyframe, so the sound must begin there too, not at the
    // exact second asked for. -noaccurate_seek does that. ffmpeg also seeks 3/23s early on files
    // with B-frames, so aim that far past the keyframe or it lands on the one before.
    const encode = copy ? null : await encoder();
    const args = copy
      ? ["-v", "error", "-noaccurate_seek", "-ss", (t + 0.14).toFixed(3), "-i", entry.file]
      : ["-v", "error", ...(await decoder(encode)), "-ss", t.toFixed(3), "-i", entry.file];
    if (burn != null) args.push("-filter_complex", burnFilter(entry, burn), "-map", "[v]");
    else args.push("-map", "0:v:0");
    args.push("-map", `0:a:${audio}?`, "-sn");
    if (copy) args.push("-c:v", "copy", ...(entry.vcodec === "hevc" ? ["-tag:v", "hvc1"] : []));
    else {
      if (burn == null) args.push("-vf", "scale=-2:'min(1080,ih)'");
      args.push(...encode);
    }
    args.push("-c:a", "aac", "-ac", "2", "-b:a", "192k", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1");
    res.statusCode = 200;
    res.setHeader("Content-Type", "video/mp4");
    if (usesNvenc(encode)) nvencRoom();
    const child = run(FFMPEG, args, res);
    if (usesNvenc(encode)) nvencAdd(child, () => child.kill());
  }

  // Each text subtitle track is copied out of its film once, into Data\subs-cache, and every later
  // tune or scrub is served from that small file instead of reading the film again.
  const subsDir = path.join(dataDir, "subs-cache");
  fs.mkdirSync(subsDir, { recursive: true });
  const SUBS_CACHE_BYTES = 200 * 1024 * 1024;
  /** Tracks ffmpeg could not convert this run. They are streamed the old way. */
  const subsFailed = new Set();
  /** One copy at a time, plus the latest one asked for. Flipping through channels never queues up a pile. */
  let subsRunning = null;
  let subsNext = null;

  function extractSubs(job) {
    if (subsRunning === job.name || subsNext?.name === job.name || fs.existsSync(path.join(subsDir, job.name))) return;
    if (subsRunning) {
      subsNext = job;
      return;
    }
    subsRunning = job.name;
    const file = path.join(subsDir, job.name);
    const tmp = `${file}.tmp`;
    const child = spawn(FFMPEG, ["-v", "error", "-y", "-i", job.source, ...job.map, "-f", "webvtt", tmp], { stdio: "ignore", windowsHide: true });
    children.add(child);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      try {
        if (ok) {
          // An older copy of the same track (the film was replaced since) goes.
          const prefix = job.name.replace(/[^-]+\.vtt$/, "");
          for (const name of fs.readdirSync(subsDir)) if (name.startsWith(prefix) && name.endsWith(".vtt")) fs.rmSync(path.join(subsDir, name), { force: true });
          fs.renameSync(tmp, file);
          trimSubsCache();
        } else {
          subsFailed.add(job.name);
          fs.rmSync(tmp, { force: true });
        }
      } catch {
        // A copy that could not be saved is made again next time.
      }
      subsRunning = null;
      const next = subsNext;
      subsNext = null;
      if (next) extractSubs(next);
    };
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  }

  /** Keep the copies under 200 MB, least recently watched dropped first. */
  function trimSubsCache() {
    const files = fs
      .readdirSync(subsDir)
      .filter((name) => name.endsWith(".vtt"))
      .map((name) => {
        const stat = fs.statSync(path.join(subsDir, name));
        return { name, size: stat.size, at: stat.mtimeMs };
      })
      .sort((a, b) => a.at - b.at);
    let total = files.reduce((sum, item) => sum + item.size, 0);
    for (const item of files) {
      if (total <= SUBS_CACHE_BYTES) break;
      fs.rmSync(path.join(subsDir, item.name), { force: true });
      total -= item.size;
    }
  }

  const vttStamp = (value) => value.trim().split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  const vttTime = (seconds) => {
    const ms = Math.round(seconds * 1000);
    const two = (n) => String(n).padStart(2, "0");
    return `${two(Math.floor(ms / 3_600_000))}:${two(Math.floor(ms / 60_000) % 60)}:${two(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, "0")}`;
  };

  /** The lines still to come after t, timed from t, as a stream started at t would have sent them. */
  function cuesFrom(vtt, t) {
    const out = ["WEBVTT", ""];
    for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
      const lines = block.split("\n");
      const at = lines.findIndex((line) => line.includes("-->"));
      if (at < 0) continue;
      const [from, rest = ""] = lines[at].split("-->");
      const start = vttStamp(from);
      const end = vttStamp(rest.trim().split(/\s+/)[0] ?? "");
      if (!(end > t) || !Number.isFinite(start)) continue;
      out.push(`${vttTime(Math.max(0, start - t))} --> ${vttTime(end - t)}`, ...lines.slice(at + 1), "");
    }
    return `${out.join("\n")}\n`;
  }

  /**
   * One subtitle track as WebVTT from t. From the copy when there is one. Until then, the next 20
   * minutes are streamed straight from the film (marked partial) while the copy is made, and
   * ?cached=1 asks for the copy only, answering 204 while it is not ready.
   */
  function sendSubs(res, id, entry, query) {
    const key = query.get("s") ?? "";
    const t = Math.max(0, Number(query.get("t")) || 0);
    const external = key.startsWith("x");
    const source = external ? entry.sidecars[Number(key.slice(1))] : entry.file;
    let mtime = 0;
    try {
      mtime = Math.round(fs.statSync(source).mtimeMs);
    } catch {
      res.statusCode = 404;
      return res.end();
    }
    const track = external ? key : String(Math.max(0, parseInt(key, 10) || 0));
    const map = external ? [] : ["-map", `0:s:${track}`];
    const name = `${id}-${track}-${mtime}.vtt`;
    const file = path.join(subsDir, name);
    const cached = query.get("cached") === "1";
    if (fs.existsSync(file)) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
        const now = new Date();
        fs.utimes(file, now, now, () => {});
      } catch {
        res.statusCode = 404;
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.end(cuesFrom(text, t));
    }
    if (subsFailed.has(name)) {
      if (cached) {
        res.statusCode = 404;
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return run(FFMPEG, ["-v", "error", "-ss", String(t), "-i", source, ...map, "-f", "webvtt", "pipe:1"], res);
    }
    extractSubs({ name, source, map });
    if (cached) {
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("X-Subs", "partial");
    run(FFMPEG, ["-v", "error", "-ss", String(t), "-t", "1200", "-i", source, ...map, "-f", "webvtt", "pipe:1"], res);
  }

  function sendKeyframe(res, entry, t) {
    // Flipping past a station drops its question; ffprobe stops with it.
    const child = execFile(
      FFPROBE,
      ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${Math.max(0, t - 20)}%${t}`, "-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv=p=0", entry.file],
      { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        let best = null;
        let delay = 0;
        for (const line of String(stdout ?? "").split(/\r?\n/)) {
          const [pts, dts, flags] = line.split(",");
          const value = Number(pts);
          if (!flags?.includes("K") || !Number.isFinite(value) || value > t || (best != null && value <= best)) continue;
          best = value;
          delay = Number.isFinite(Number(dts)) ? Math.max(0, value - Number(dts)) : 0;
        }
        // `base` is the film time at the first instant of the stream: the keyframe, less its decode delay.
        if (!res.destroyed) sendJson(res, 200, { found: best != null, t: best ?? t, base: Math.max(0, (best ?? t) - delay) });
      },
    );
    res.on("close", () => child.kill());
  }

  /**
   * The full episode list for a show, from TVmaze (free, no key). This is the only call that
   * leaves the machine, it sends nothing but the show's name, and it runs only when asked.
   */
  async function sendEpisodes(res, show, year, refresh) {
    const key = `${show.toLowerCase().trim()}${year ? `|${year}` : ""}`;
    const all = readJson(episodesFile, {});
    if (!key) return sendJson(res, 400, { error: "No show name" });
    if (!all[key] || refresh) {
      try {
        // Several shows share a name (Doctor Who 1963, 2005, 2023). The year in the file names picks the right one.
        const search = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(show)}`, { signal: AbortSignal.timeout(12_000) });
        if (!search.ok) return sendJson(res, 502, { error: `TVmaze answered ${search.status}` });
        const results = (await search.json()).map((hit) => hit.show);
        const pick = results.find((item) => year && String(item.premiered ?? "").startsWith(year)) ?? results[0];
        const response = pick ? await fetch(`https://api.tvmaze.com/shows/${pick.id}?embed=episodes`, { signal: AbortSignal.timeout(12_000) }) : null;
        if (!response) all[key] = { found: false };
        else if (!response.ok) return sendJson(res, 502, { error: `TVmaze answered ${response.status}` });
        else {
          const data = await response.json();
          const seasons = {};
          for (const item of data._embedded?.episodes ?? []) {
            // Specials have no number. Episodes that have not aired yet are not missing.
            if (!item.number || !item.season || (item.airstamp && Date.parse(item.airstamp) > Date.now())) continue;
            (seasons[item.season] ??= []).push(item.number);
          }
          all[key] = { found: true, name: data.name, year: String(data.premiered ?? "").slice(0, 4), seasons };
        }
        fs.writeFileSync(episodesFile, JSON.stringify(all));
      } catch {
        return sendJson(res, 502, { error: "Could not reach TVmaze. Check the internet connection." });
      }
    }
    sendJson(res, 200, all[key]);
  }

  /** One small file per saved setting. Written to a temporary name, then renamed, so a crash never leaves half a file. */
  const storeFile = (key) => path.join(storeDir, `${crypto.createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`);

  function readStore() {
    const all = {};
    for (const name of fs.readdirSync(storeDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const item = JSON.parse(fs.readFileSync(path.join(storeDir, name), "utf8"));
        if (typeof item.key === "string" && typeof item.value === "string") all[item.key] = item.value;
      } catch {
        // A damaged file is skipped, not fatal.
      }
    }
    return all;
  }

  /** The newest stations backup of any kind (hourly, on closing, or made by hand), as text. */
  function newestBackup() {
    let newest = null;
    for (const name of fs.readdirSync(backupDir)) {
      if (!name.startsWith("stations ") || !name.endsWith(".json")) continue;
      const at = fs.statSync(path.join(backupDir, name)).mtimeMs;
      if (!newest || at > newest.at) newest = { name, at };
    }
    return newest ? fs.readFileSync(path.join(backupDir, newest.name), "utf8") : null;
  }
  /** The hour already dealt with, so the backups folder is not read on every save. */
  let backupHour = "";

  function writeStore(key, value) {
    const file = storeFile(key);
    // Stations also get one copy per hour, taken from just before that hour's first change, unless it is
    // the same as the newest backup already there. The 72 newest hourly copies are kept; copies made on
    // closing are kept separately (30), and copies made by hand are never removed.
    const hour = new Date().toISOString().slice(0, 13).replace("T", " ");
    if (key.startsWith("parlor.v2") && hour !== backupHour && fs.existsSync(file)) {
      const copy = path.join(backupDir, `stations ${hour}h.json`);
      try {
        const before = JSON.parse(fs.readFileSync(file, "utf8")).value;
        if (!fs.existsSync(copy) && before !== newestBackup()) {
          fs.writeFileSync(copy, before);
          const old = fs.readdirSync(backupDir).filter((name) => /^stations \d{4}-\d\d-\d\d \d\dh\.json$/.test(name)).sort().slice(0, -72);
          for (const name of old) fs.rmSync(path.join(backupDir, name), { force: true });
        }
        backupHour = hour;
      } catch {
        // A missed hourly copy is not worth failing the save over.
      }
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ key, value, at: new Date().toISOString() }));
    fs.renameSync(tmp, file);
  }

  function readText(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  // ---------------------------------------------------------------- YouTube
  const youtube = createYoutube({ dataDir, findTool, pool });

  // ---------------------------------------------------------------- TMDB
  // Genres, collections and directors, looked up once per title and kept in a file.
  // The token stays in its own file on this PC and is never sent to a phone.
  const tmdbFile = path.join(dataDir, "parlor-tmdb.json");
  const metaFile = path.join(dataDir, "parlor-metadata.json");
  const tmdb = { running: false, done: 0, total: 0, error: null };

  /**
   * A token shipped with the app, so nobody has to make a TMDB account to get genres. It comes from
   * server/tmdb-key.json (written at package time from VAYAVIEW_TMDB_TOKEN; never committed) or that
   * variable itself. A token the user saves under Settings takes its place.
   */
  function builtInToken() {
    const fromEnv = (process.env.VAYAVIEW_TMDB_TOKEN ?? "").trim();
    if (fromEnv) return fromEnv;
    const fromFile = readJson(path.join(import.meta.dirname, "tmdb-key.json"), {}).token;
    return typeof fromFile === "string" && fromFile.trim() ? fromFile.trim() : null;
  }
  const activeToken = () => readJson(tmdbFile, {}).token || builtInToken();

  async function tmdbGet(pathname, token, tries = 0) {
    const response = await fetch(`https://api.themoviedb.org/3${pathname}`, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) throw new Error("TMDB did not accept that token.");
    if (response.status === 429 && tries < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return tmdbGet(pathname, token, tries + 1);
    }
    if (!response.ok) throw new Error(`TMDB answered ${response.status}`);
    return response.json();
  }

  async function lookUp(item, token) {
    const query = encodeURIComponent(item.title);
    const kind = item.kind === "tv" ? "tv" : "movie";
    const yearParam = kind === "movie" ? "primary_release_year" : "first_air_date_year";
    let hits = (await tmdbGet(`/search/${kind}?query=${query}${item.year ? `&${yearParam}=${item.year}` : ""}`, token)).results ?? [];
    if (hits.length === 0 && item.year) hits = (await tmdbGet(`/search/${kind}?query=${query}`, token)).results ?? [];
    const hit = hits[0];
    if (!hit) return { found: false };
    const detail = await tmdbGet(`/${kind}/${hit.id}?append_to_response=keywords${kind === "movie" ? ",credits" : ""}`, token);
    const keywords = (detail.keywords?.keywords ?? detail.keywords?.results ?? []).slice(0, 12).map((word) => word.name);
    return {
      found: true,
      tmdbId: `${kind}/${detail.id}`,
      title: detail.title ?? detail.name ?? item.title,
      year: Number(String(detail.release_date ?? detail.first_air_date ?? "").slice(0, 4)) || 0,
      genres: (detail.genres ?? []).map((genre) => genre.name),
      collection: detail.belongs_to_collection?.name ?? null,
      director:
        kind === "movie"
          ? ((detail.credits?.crew ?? []).find((person) => person.job === "Director")?.name ?? "")
          : (detail.created_by ?? []).map((person) => person.name).join(", "),
      keywords,
      overview: detail.overview ?? "",
    };
  }

  async function runLookups(items) {
    const token = activeToken();
    if (!token || tmdb.running) return;
    const meta = readJson(metaFile, {});
    const todo = items.filter((item) => item?.key && item.title && !meta[item.key]);
    if (todo.length === 0) return;
    Object.assign(tmdb, { running: true, done: 0, total: todo.length, error: null });
    try {
      await pool(todo, 4, async (item) => {
        try {
          meta[item.key] = await lookUp(item, token);
        } catch (error) {
          tmdb.error = error.message;
          if (/token/.test(error.message)) throw error;
        }
        if (++tmdb.done % 25 === 0) fs.writeFileSync(metaFile, JSON.stringify(meta));
      });
    } catch {
      // A refused token stops the run; the error is shown in the app.
    }
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    tmdb.running = false;
  }

  function tmdbStatus() {
    const meta = Object.values(readJson(metaFile, {}));
    return {
      hasToken: Boolean(activeToken()),
      /** True when the token in use is the one shipped with the app, not one the user saved. */
      builtIn: !readJson(tmdbFile, {}).token && Boolean(builtInToken()),
      ...tmdb,
      matched: meta.filter((item) => item.found).length,
      unmatched: meta.filter((item) => !item.found).length,
    };
  }

  // ---------------------------------------------------------------- Phone
  // Off unless switched on. When on, the app also listens on the home network
  // (see electron/main.mjs), and a phone must pair with a PIN before anything but
  // the page itself is served to it.
  const phoneFile = path.join(dataDir, "parlor-phone.json");
  const PHONE_PORT = 47817;
  const newPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  function phoneConfig() {
    const config = readJson(phoneFile, null) ?? { enabled: false, pin: newPin(), tokens: [] };
    if (!config.pin) config.pin = newPin();
    if (!Array.isArray(config.tokens)) config.tokens = [];
    return config;
  }
  const savePhone = (config) => fs.writeFileSync(phoneFile, JSON.stringify(config, null, 2));
  const pairTries = [];

  function lanAddresses() {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((net) => net && net.family === "IPv4" && !net.internal && !net.address.startsWith("169.254."))
      .map((net) => `http://${net.address}:${PHONE_PORT}`);
  }

  // What the PC is showing, so a phone can follow it.
  let nowShowing = null;

  // ---------------------------------------------------------------- iPhone video (HLS)
  // iPhones take Apple's streaming format. The picture is copied as it is whenever the
  // phone can play it, so this costs next to nothing; only odd formats are re-encoded.
  const hlsRoot = path.join(dataDir, "temp-streams");
  /**
   * Clear a stream's temporary folder. ffmpeg can still be finishing a piece in it, so this
   * retries quietly, and a folder that will not go is left for the next start-up. It never throws.
   */
  const clearDir = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }, () => {});
  try {
    fs.rmSync(hlsRoot, { recursive: true, force: true });
  } catch {
    // Something from last time is still locked. New streams get their own folders anyway.
  }
  fs.mkdirSync(hlsRoot, { recursive: true });
  const hlsSessions = new Map();

  function endHls(sid) {
    const session = hlsSessions.get(sid);
    if (!session) return;
    hlsSessions.delete(sid);
    void session.ready.then((stream) => {
      if (!stream) return;
      // Wait for ffmpeg to actually stop before removing what it was writing.
      if (stream.child.exitCode == null && stream.child.signalCode == null) stream.child.once("exit", () => clearDir(stream.dir));
      else clearDir(stream.dir);
      stream.child.kill();
    });
  }
  // A phone that stops asking for pieces has gone. Its session goes too.
  setInterval(() => {
    for (const [sid, session] of hlsSessions) if (Date.now() - session.lastHit > 45_000) endHls(sid);
  }, 10_000).unref();

  async function startHls(sid, entry, query) {
    const t = Math.max(0, Number(query.get("t")) || 0);
    const audio = Math.max(0, parseInt(query.get("a") ?? "0", 10) || 0);
    const burn = query.get("burn") == null ? null : Math.max(0, parseInt(query.get("burn"), 10) || 0);
    const copy = query.get("v") === "copy" && burn == null;
    const dir = path.join(hlsRoot, `${sid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const encode = copy ? null : await encoder("hls");
    const args = copy
      ? ["-v", "error", "-noaccurate_seek", "-ss", (t + 0.14).toFixed(3)]
      : ["-v", "error", ...(await decoder(encode)), "-ss", t.toFixed(3)];
    // Read as fast as it is watched, after a 40 s head start, so a whole film is never copied to disk at once.
    // Not faster: the playlist only keeps the last three minutes, and a stream that ran further and further
    // ahead would delete the piece the phone is still playing.
    args.push("-readrate", "1", "-readrate_initial_burst", "40", "-i", entry.file);
    if (burn != null) args.push("-filter_complex", burnFilter(entry, burn), "-map", "[v]");
    else args.push("-map", "0:v:0");
    args.push("-map", `0:a:${audio}?`, "-sn");
    if (copy) args.push("-c:v", "copy", ...(entry.vcodec === "hevc" ? ["-tag:v", "hvc1"] : []));
    else {
      if (burn == null) args.push("-vf", "scale=-2:'min(1080,ih)'");
      args.push(...encode, "-g", "96");
    }
    args.push(
      "-c:a", "aac", "-ac", "2", "-b:a", "192k",
      // A sliding window of 90 two-second pieces (three minutes); older pieces are deleted, so the folder stays small.
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "90", "-hls_flags", "delete_segments+independent_segments",
      "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", "seg%05d.m4s", "index.m3u8",
    );
    // Run inside the session folder: ffmpeg puts the init piece in its working folder, whatever the playlist path says.
    if (usesNvenc(encode)) nvencRoom();
    const child = spawn(FFMPEG, args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    // Stopped this way, the phone's next request finds nothing and it tunes again; the folder goes with the session.
    if (usesNvenc(encode)) nvencAdd(child, () => child.kill());
    children.add(child);
    child.on("error", () => children.delete(child));
    child.on("exit", () => children.delete(child));
    return { dir, child };
  }

  async function sendHls(req, res, part, query) {
    // /hls/<session>/<media id>/<file>
    const [sid, id, file] = [part[2], part[3], part[4]];
    const entry = index.get(id ?? "");
    if (!sid || !/^[\w-]{6,64}$/.test(sid) || !entry || !file || file.includes("..")) {
      res.statusCode = 404;
      return res.end();
    }
    let session = hlsSessions.get(sid);
    if (file === "index.m3u8") {
      const key = `${id}?${query.toString()}`;
      if (!session || session.key !== key) {
        endHls(sid);
        // The same phone moved on: let its previous stream finish its last requests, then stop it. When
        // flipping fast, only the stream just left gets that grace; any older ones stop now.
        const phone = sid.split("-")[0];
        const older = [...hlsSessions.entries()].filter(([other]) => other !== sid && other.split("-")[0] === phone).sort((a, b) => a[1].started - b[1].started);
        for (const [other] of older.slice(0, -1)) endHls(other);
        const [last, lastSession] = older.at(-1) ?? [];
        if (last && !lastSession.leaving) {
          lastSession.leaving = true;
          setTimeout(() => endHls(last), 5000);
        }
        // Recorded before ffmpeg starts, so a second request for the same playlist joins this stream instead of starting another.
        session = { key, started: Date.now(), lastHit: Date.now(), ready: startHls(sid, entry, query).catch(() => null) };
        hlsSessions.set(sid, session);
      }
    }
    if (!session) {
      res.statusCode = 404;
      return res.end();
    }
    session.lastHit = Date.now();
    const stream = await session.ready;
    if (!stream) {
      res.statusCode = 404;
      return res.end();
    }
    const target = path.join(stream.dir, file);
    // The first pieces take a moment to appear.
    for (let i = 0; i < 75 && !res.destroyed; i++) {
      if (fs.existsSync(target) && (file !== "index.m3u8" || /#EXTINF/.test(fs.readFileSync(target, "utf8")))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The phone gave up waiting (or moved on): send nothing.
    if (res.destroyed) return;
    if (!fs.existsSync(target)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("Cache-Control", "no-store");
    if (file === "index.m3u8") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      // Start at the top of what was asked for, not at the live end of the list.
      return res.end(fs.readFileSync(target, "utf8").replace("#EXTM3U", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"));
    }
    res.setHeader("Content-Type", file.endsWith(".m4s") ? "video/iso.segment" : "video/mp4");
    // pipeline closes the file when the phone hangs up halfway; .pipe() left it open.
    pipeline(fs.createReadStream(target), res, () => {});
  }

  // ---------------------------------------------------------------- Library folders and stations
  // Saved stations are filed under the library's folder list (parlor.v2.disk:<folders>), so a new
  // folder would otherwise open on an empty set. When the list changes, the newest stations come
  // along to the new name. The old copy is never removed, and an overwritten one gets an hourly backup.
  const stationKey = (list) => `parlor.v2.disk:${list.join("|")}`;

  function setFolders(list) {
    const config = readJson(configFile, null) ?? {};
    const before = stationKey(folders());
    fs.writeFileSync(configFile, JSON.stringify({ ...config, folders: list, previous: before }, null, 2));
    followStations();
  }

  /** Also run whenever the app loads its saved settings, for stations saved under the old name after the change. */
  function followStations() {
    try {
      const previous = readJson(configFile, null)?.previous;
      const current = stationKey(folders());
      if (typeof previous !== "string" || previous === current) return;
      const from = readJson(storeFile(previous), null);
      if (typeof from?.value !== "string") return;
      const to = readJson(storeFile(current), null);
      if (to && Date.parse(to.at) >= Date.parse(from.at)) return;
      writeStore(current, from.value);
    } catch {
      // The stations stay where they were; nothing is lost.
    }
  }

  /** Measure new files now, so they are ready when the guide next loads. Waits for a scan already running. */
  async function rescanSoon() {
    if (scanning) await scanning.catch(() => {});
    scanning ??= scan().finally(() => (scanning = null));
    await scanning.catch(() => {});
  }

  // ---------------------------------------------------------------- Vintage TV
  // Old TV recordings from the Internet Archive (archive.org): search, pick a file, download it into
  // a folder that becomes part of the library. PC only; a phone can do none of this (handler.remote).
  const IA = "https://archive.org";
  const MAX_BYTES = 5e9;
  const IA_VIDEO = /\.(mp4|m4v|mkv|avi|mov|mpe?g|ogv|webm|wmv|flv)$/i;
  const FOLDER_KEY = "parlor.vintage.folder";
  const downloadsFile = path.join(dataDir, "parlor-downloads.json");
  const text = (value) => (Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value));

  /** Seconds from the ways archive.org writes a running time: "1847.2", "00:22:31", "30 minutes", "1h 2m". */
  function seconds(value) {
    const raw = text(value).trim().toLowerCase();
    if (!raw) return 0;
    if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(raw)) return Math.round(raw.split(":").reduce((total, part) => total * 60 + Number(part), 0));
    const unit = (pattern) => Number(pattern.exec(raw)?.[1] ?? 0);
    const spelled = unit(/(\d+(?:\.\d+)?)\s*h/) * 3600 + unit(/(\d+(?:\.\d+)?)\s*m(?!s)/) * 60 + unit(/(\d+(?:\.\d+)?)\s*s/);
    if (spelled) return Math.round(spelled);
    const plain = Number(raw);
    return Number.isFinite(plain) ? Math.round(plain) : 0;
  }

  /** Every archive.org answer is kept for half an hour, so going back and forth costs nothing. */
  const iaCache = new Map();
  async function iaJson(url) {
    const hit = iaCache.get(url);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
    const response = await fetch(url, { headers: { "User-Agent": "VayaView" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`The Internet Archive answered ${response.status}`);
    const value = await response.json();
    iaCache.set(url, { at: Date.now(), value });
    if (iaCache.size > 200) iaCache.delete(iaCache.keys().next().value);
    return value;
  }

  /** Up to 50 items under 5 GB, the most watched first from archive.org, then shown smallest first. */
  async function vintageSearch(q) {
    const params = new URLSearchParams({ q: `(${q}) AND mediatype:movies AND item_size:[1 TO ${MAX_BYTES}]`, rows: "50", page: "1", output: "json" });
    for (const field of ["identifier", "title", "item_size", "downloads", "date", "description", "runtime"]) params.append("fl[]", field);
    params.append("sort[]", "downloads desc");
    const data = await iaJson(`${IA}/advancedsearch.php?${params}`);
    return (data.response?.docs ?? [])
      .map((doc) => ({
        id: String(doc.identifier),
        title: text(doc.title) || String(doc.identifier),
        size: Number(doc.item_size) || 0,
        downloads: Number(doc.downloads) || 0,
        date: text(doc.date).slice(0, 10),
        description: text(doc.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
        runtime: seconds(doc.runtime),
      }))
      .filter((item) => item.size > 0 && item.size <= MAX_BYTES)
      .sort((a, b) => a.size - b.size);
  }

  /**
   * An item's video files under 5 GB. archive.org often keeps a huge original (MPEG-2, AVI) beside its
   * own MP4 copy; for each original the MP4 is marked as the one to get, since it plays straight away.
   */
  async function vintageItem(id) {
    const data = await iaJson(`${IA}/metadata/${encodeURIComponent(id)}`);
    const all = (data.files ?? []).filter((file) => IA_VIDEO.test(file.name ?? "") && file.format !== "Thumbnail" && !/thumb|sample/i.test(file.name));
    const lengthOf = new Map(all.map((file) => [file.name, seconds(file.length)]));
    const files = all
      .map((file) => {
        const original = file.source === "derivative" && file.original ? file.original : file.name;
        return { name: file.name, size: Number(file.size) || 0, length: seconds(file.length) || lengthOf.get(original) || 0, format: text(file.format), original, best: false };
      })
      .filter((file) => file.size > 0 && file.size <= MAX_BYTES);
    const rank = (file) => (/\.(mp4|m4v)$/i.test(file.name) ? 0 : 2) + (/512kb/i.test(`${file.format} ${file.name}`) ? 1 : 0);
    const groups = new Map();
    for (const file of files) groups.set(file.original, [...(groups.get(file.original) ?? []), file]);
    for (const group of groups.values()) group.slice().sort((a, b) => rank(a) - rank(b) || a.size - b.size)[0].best = true;
    files.sort((a, b) => Number(b.best) - Number(a.best) || a.size - b.size);
    const meta = data.metadata ?? {};
    return { id, title: text(meta.title) || id, date: text(meta.date).slice(0, 10), runtime: seconds(meta.runtime), files };
  }

  /** Windows: D:\SelfTV\Downloads, beside Data and outside the program folder (an update mirrors that one). Mac: ~/Movies/VayaView. */
  function downloadFolder() {
    const saved = readJson(storeFile(FOLDER_KEY), null)?.value;
    if (typeof saved === "string" && saved) return saved;
    return options.downloadsDir ?? (process.platform === "darwin" ? path.join(os.homedir(), "Movies", "VayaView") : path.join(path.dirname(dataDir), "Downloads"));
  }

  // The list survives restarts. Anything that was under way comes back paused, with its .part kept.
  let downloads = [readJson(downloadsFile, [])].flat().filter((item) => item?.id && item.dest).map((item) => {
    if (item.state === "done" || item.state === "error") return { ...item, speed: 0 };
    let bytes = 0;
    try {
      bytes = fs.statSync(`${item.dest}.part`).size;
    } catch {
      // Not started yet.
    }
    return { ...item, state: "paused", bytes, speed: 0 };
  });
  const active = new Map();
  const saveDownloads = () => {
    try {
      fs.writeFileSync(downloadsFile, JSON.stringify(downloads.map(({ speed, ...item }) => item), null, 2));
    } catch {
      // The list is only a convenience; the files themselves are what matter.
    }
  };
  const safeName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 100) || "Recording";

  function addDownload(body) {
    const identifier = String(body?.identifier ?? "");
    const file = String(body?.file ?? "");
    if (!/^[\w.-]+$/.test(identifier) || !file || file.split("/").includes("..") || !IA_VIDEO.test(file)) throw new Error("That is not a video file on archive.org.");
    const same = downloads.find((item) => item.identifier === identifier && item.file === file && item.state !== "done");
    if (same) return same;
    // One folder per archive.org item, named after it: a series' episodes stay together, as a show.
    const dest = path.join(downloadFolder(), safeName(String(body?.title ?? identifier)), safeName(path.basename(file)));
    const item = {
      id: crypto.randomBytes(6).toString("hex"),
      identifier,
      file,
      title: String(body?.title ?? identifier).slice(0, 200),
      url: `${IA}/download/${identifier}/${file.split("/").map(encodeURIComponent).join("/")}`,
      dest,
      bytes: 0,
      total: Number(body?.size) || 0,
      state: "queued",
      error: null,
      speed: 0,
    };
    downloads.push(item);
    saveDownloads();
    pump();
    return item;
  }

  /** Two at a time, oldest first. */
  function pump() {
    for (const item of downloads) {
      if (active.size >= 2) break;
      if (item.state === "queued" && !active.has(item.id)) void runDownload(item);
    }
  }

  async function runDownload(item) {
    const control = new AbortController();
    active.set(item.id, control);
    Object.assign(item, { state: "downloading", error: null, speed: 0 });
    const part = `${item.dest}.part`;
    try {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      // A partly downloaded file carries on from where it stopped.
      const response = await fetch(item.url, { headers: { "User-Agent": "VayaView", ...(have ? { Range: `bytes=${have}-` } : {}) }, signal: control.signal });
      if (response.status !== 416) {
        if (!response.ok || !response.body) throw new Error(`The Internet Archive answered ${response.status}`);
        // The server ignored the resume request and sent the whole file: start again.
        if (response.status !== 206) have = 0;
        const length = Number(response.headers.get("content-length")) || 0;
        if (length) item.total = have + length;
        item.bytes = have;
        const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
        let since = Date.now();
        let counted = 0;
        try {
          for await (const chunk of response.body) {
            item.bytes += chunk.length;
            counted += chunk.length;
            const now = Date.now();
            if (now - since >= 1000) {
              item.speed = Math.round((counted * 1000) / (now - since));
              since = now;
              counted = 0;
            }
            if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
          }
        } finally {
          await new Promise((resolve) => out.end(resolve));
        }
      }
      const size = fs.statSync(part).size;
      if (item.total && size < item.total) throw new Error("The download stopped early. Resume to carry on.");
      // Never over an existing file: "name (2).mp4" instead.
      let final = item.dest;
      for (let n = 2; fs.existsSync(final); n++) final = item.dest.replace(/(\.[^.]+)$/, ` (${n})$1`);
      fs.renameSync(part, final);
      Object.assign(item, { dest: final, state: "done", bytes: size, total: size, speed: 0 });
      void finished(path.dirname(path.dirname(final)));
    } catch (error) {
      item.speed = 0;
      if (item.state === "cancelled") fs.rm(part, { force: true, maxRetries: 4, retryDelay: 300 }, () => {});
      else if (!control.signal.aborted) Object.assign(item, { state: "error", error: error?.message ?? String(error) });
    } finally {
      active.delete(item.id);
      if (item.state === "cancelled") downloads = downloads.filter((other) => other !== item);
      saveDownloads();
      pump();
    }
  }

  /** A finished recording joins the library: its folder is added if need be, and the new files are measured. */
  async function finished(folder) {
    const roots = folders();
    const inside = roots.some((root) => {
      const rel = path.relative(root, folder);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!inside) setFolders([...roots, folder]);
    await rescanSoon();
  }

  function downloadsStatus() {
    // The library folders too: a window opened before one was added must reload, not just rescan.
    return { folder: downloadFolder(), folders: folders(), items: downloads.map(({ url, ...item }) => item) };
  }

  async function sendVintage(req, res, url, part) {
    try {
      if (url.pathname === "/api/vintage/search") {
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
        if (!q) return sendJson(res, 400, { error: "Type something to look for." });
        return sendJson(res, 200, { results: await vintageSearch(q) });
      }
      if (part[3] === "item" && part[4]) return sendJson(res, 200, await vintageItem(decodeURIComponent(part[4])));
      if (url.pathname === "/api/vintage/downloads") return sendJson(res, 200, downloadsStatus());
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      if (url.pathname === "/api/vintage/download") {
        addDownload(await readBody(req));
        return sendJson(res, 200, downloadsStatus());
      }
      if (url.pathname === "/api/vintage/folder") {
        const body = (await readBody(req)) ?? {};
        let folder = typeof body.path === "string" ? body.path.trim() : "";
        if (body.pick) folder = (await options.pickFolder?.("Where should Vintage TV recordings go?", downloadFolder())) ?? "";
        if (folder) {
          folder = path.resolve(expandHome(folder));
          fs.mkdirSync(folder, { recursive: true });
          writeStore(FOLDER_KEY, folder);
        }
        return sendJson(res, 200, downloadsStatus());
      }
      // /api/vintage/downloads/<id>/<pause|resume|cancel|remove>
      const item = downloads.find((other) => other.id === part[4]);
      if (!item) return sendJson(res, 404, { error: "No such download" });
      const action = part[5];
      if (action === "pause" && (item.state === "downloading" || item.state === "queued")) {
        item.state = "paused";
        active.get(item.id)?.abort();
      } else if (action === "resume" && (item.state === "paused" || item.state === "error")) {
        item.state = "queued";
        pump();
      } else if (action === "cancel" && item.state !== "done") {
        // Stops it and throws away the part downloaded so far.
        const running = active.get(item.id);
        item.state = "cancelled";
        if (running) running.abort();
        else {
          fs.rm(`${item.dest}.part`, { force: true }, () => {});
          downloads = downloads.filter((other) => other !== item);
        }
      } else if (action === "remove" && item.state === "done") {
        // Off the list only; the recording stays in the library.
        downloads = downloads.filter((other) => other !== item);
      }
      saveDownloads();
      return sendJson(res, 200, downloadsStatus());
    } catch (error) {
      return sendJson(res, 502, { error: error?.name === "TimeoutError" ? "The Internet Archive took too long to answer. Try again." : (error?.message ?? String(error)) });
    }
  }

  async function handler(req, res, next) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const part = url.pathname.split("/");

    if (url.pathname === "/api/library" && req.method === "GET") {
      // ?rescan=1 (the Rescan button) always walks the folders again.
      const recent = lastScan && Date.now() - lastScan.at < 10 * 60_000 && lastScan.result.folders.join("|") === folders().join("|");
      if (recent && !scanning && url.searchParams.get("rescan") !== "1") return sendJson(res, 200, lastScan.result);
      scanning ??= scan().finally(() => (scanning = null));
      try {
        return sendJson(res, 200, await scanning);
      } catch (error) {
        status.phase = "idle";
        return sendJson(res, 500, { error: String(error) });
      }
    }
    if (url.pathname === "/api/status") return sendJson(res, 200, status);
    if (await youtube.handle(req, res, url)) return;

    // Font files the user added, kept in Data\fonts.
    if (url.pathname === "/api/fonts" || url.pathname.startsWith("/api/fonts/file/")) {
      const fontDir = path.join(dataDir, "fonts");
      fs.mkdirSync(fontDir, { recursive: true });
      if (url.pathname.startsWith("/api/fonts/file/")) {
        const name = path.basename(decodeURIComponent(url.pathname.slice("/api/fonts/file/".length)));
        const file = path.join(fontDir, name);
        if (!fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        const types = { ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2" };
        res.setHeader("Content-Type", types[path.extname(name).toLowerCase()] ?? "application/octet-stream");
        return pipeline(fs.createReadStream(file), res, () => {});
      }
      if (req.method === "PUT") {
        const name = path.basename(url.searchParams.get("name") ?? "");
        if (!/\.(ttf|otf|woff2?)$/i.test(name)) return sendJson(res, 400, { error: "Use a .ttf, .otf, .woff or .woff2 file." });
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        fs.writeFileSync(path.join(fontDir, name), Buffer.concat(chunks));
      }
      return sendJson(res, 200, fs.readdirSync(fontDir).filter((name) => /\.(ttf|otf|woff2?)$/i.test(name)).sort());
    }

    // Updates: the Electron shell does the work (it knows where the program lives).
    if (url.pathname === "/api/update") {
      if (!options.update) return sendJson(res, 200, { supported: false, available: false, current: "", latest: null });
      return sendJson(res, 200, await options.update.check(url.searchParams.get("fresh") === "1"));
    }
    if (url.pathname === "/api/update/install" && req.method === "POST") {
      if (!options.update) return sendJson(res, 400, { error: "Not available here." });
      void options.update.install();
      return sendJson(res, 202, { ok: true });
    }

    if (url.pathname === "/api/tmdb" && req.method === "GET") return sendJson(res, 200, tmdbStatus());
    if (url.pathname === "/api/tmdb/metadata") return sendJson(res, 200, readJson(metaFile, {}));
    if (url.pathname === "/api/tmdb/token" && req.method === "POST") {
      const token = String((await readBody(req))?.token ?? "").trim();
      if (!token) {
        fs.rmSync(tmdbFile, { force: true });
        return sendJson(res, 200, tmdbStatus());
      }
      try {
        await tmdbGet("/authentication", token);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      fs.writeFileSync(tmdbFile, JSON.stringify({ token }));
      return sendJson(res, 200, tmdbStatus());
    }
    if (url.pathname === "/api/tmdb/lookup" && req.method === "POST") {
      const body = await readBody(req);
      if (url.searchParams.get("again") === "1") fs.rmSync(metaFile, { force: true });
      void runLookups(Array.isArray(body?.items) ? body.items : []);
      return sendJson(res, 202, tmdbStatus());
    }

    if (url.pathname === "/api/phone") {
      const config = phoneConfig();
      if (req.method === "POST") {
        const body = (await readBody(req)) ?? {};
        if (typeof body.enabled === "boolean") config.enabled = body.enabled;
        // A new PIN also forgets every paired phone.
        if (body.forget) Object.assign(config, { pin: newPin(), tokens: [] });
        savePhone(config);
        await options.onPhone?.(config.enabled);
      }
      return sendJson(res, 200, {
        enabled: config.enabled,
        pin: config.pin,
        paired: config.tokens.length,
        addresses: lanAddresses(),
        available: Boolean(options.onPhone),
      });
    }
    if (url.pathname === "/api/now") {
      if (req.method === "POST") nowShowing = { ...(await readBody(req)), at: Date.now() };
      return sendJson(res, 200, nowShowing ?? {});
    }
    if (part[1] === "hls") return sendHls(req, res, part, url.searchParams);
    if (part[1] === "api" && part[2] === "vintage") return sendVintage(req, res, url, part);
    if (url.pathname === "/api/store") {
      if (req.method === "GET") {
        followStations();
        return sendJson(res, 200, readStore());
      }
      const key = url.searchParams.get("key") ?? "";
      if (!key) return sendJson(res, 400, { error: "No key" });
      try {
        if (req.method === "PUT") writeStore(key, await readText(req));
        else if (req.method === "DELETE") fs.rmSync(storeFile(key), { force: true });
        res.statusCode = 204;
        return res.end();
      } catch (error) {
        return sendJson(res, 500, { error: String(error) });
      }
    }
    if (url.pathname === "/api/episodes") {
      return sendEpisodes(res, url.searchParams.get("show") ?? "", url.searchParams.get("year") ?? "", url.searchParams.get("refresh") === "1");
    }

    // The system's folder chooser, opened on the PC (the Electron shell owns it).
    if (url.pathname === "/api/pick-folder" && req.method === "POST") {
      if (!options.pickFolder) return sendJson(res, 200, { path: null, available: false });
      const body = (await readBody(req)) ?? {};
      const start = typeof body.from === "string" && body.from ? expandHome(body.from) : undefined;
      return sendJson(res, 200, { path: await options.pickFolder(String(body.title ?? "Choose a folder"), start), available: true });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const wanted = Array.isArray(body?.folders) ? body.folders.map((item) => path.resolve(expandHome(String(item)))) : [];
      const bad = wanted.filter((dir) => !fs.existsSync(dir) || !fs.statSync(dir).isDirectory());
      if (bad.length > 0) return sendJson(res, 400, { error: `Not a folder: ${bad.join(", ")}` });
      setFolders(wanted);
      return sendJson(res, 200, { folders: wanted });
    }

    if (part[1] === "media" || part[1] === "subs" || (part[1] === "api" && part[2] === "keyframe")) {
      const entry = index.get(part[part.length - 1]);
      if (!entry) {
        res.statusCode = 404;
        return res.end();
      }
      if (part[1] === "subs") return sendSubs(res, part[part.length - 1], entry, url.searchParams);
      if (part[1] === "api") return sendKeyframe(res, entry, Math.max(0, Number(url.searchParams.get("t")) || 0));
      if (url.searchParams.get("t") != null) return sendSession(res, entry, url.searchParams);
      return sendDirect(req, res, entry);
    }

    next();
  }

  /**
   * The door for phones on the home network. The page itself is open; everything
   * else needs a paired phone; settings and saving stay PC-only.
   */
  handler.remote = async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const config = phoneConfig();
    if (!config.enabled) {
      res.statusCode = 403;
      return res.end("Phone access is switched off in Parlor on the PC.");
    }
    if (url.pathname === "/api/pair" && req.method === "POST") {
      const now = Date.now();
      while (pairTries.length && now - pairTries[0] > 10 * 60_000) pairTries.shift();
      if (pairTries.length >= 10) return sendJson(res, 429, { error: "Too many wrong PINs. Wait ten minutes." });
      const pin = String((await readBody(req))?.pin ?? "");
      if (pin !== config.pin) {
        pairTries.push(now);
        return sendJson(res, 403, { error: "That PIN is not right." });
      }
      const token = crypto.randomBytes(24).toString("hex");
      config.tokens = [...config.tokens, token].slice(-10);
      savePhone(config);
      res.setHeader("Set-Cookie", `parlor_phone=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      return sendJson(res, 200, { ok: true });
    }
    if (!/^\/(api|media|subs|hls)(\/|$)/.test(url.pathname)) return next();
    const cookie = /(?:^|;\s*)parlor_phone=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!cookie || !config.tokens.includes(cookie)) return sendJson(res, 401, { error: "pair" });
    const pcOnly =
      /^\/api\/(phone|config|pick-folder|vintage|tmdb\/token|tmdb\/lookup|pair|update)/.test(url.pathname) ||
      // yt-dlp runs on the PC's word only. A phone may read which videos the stations use, so its guide has their names.
      (url.pathname.startsWith("/api/youtube") && !(url.pathname === "/api/youtube/library" && req.method === "GET")) ||
      (url.pathname === "/api/fonts" && req.method !== "GET") ||
      (url.pathname === "/api/store" && req.method !== "GET") ||
      (url.pathname === "/api/now" && req.method !== "GET");
    if (pcOnly) return sendJson(res, 403, { error: "Only from the PC." });
    return handler(req, res, next);
  };
  /**
   * A copy of the stations as they are right now, kept beside the hourly ones. Taken every time
   * Parlor closes, so the last good state is always on disk under its own name. The 30 newest stay.
   */
  handler.snapshot = (label) => {
    try {
      const file = storeFile(`parlor.v2.disk:${folders().join("|")}`);
      if (!fs.existsSync(file)) return;
      const stamp = new Date().toLocaleString("sv-SE").replace(/:/g, ".").slice(0, 16);
      fs.writeFileSync(path.join(backupDir, `stations ${label} ${stamp}.json`), JSON.parse(fs.readFileSync(file, "utf8")).value);
      const old = fs.readdirSync(backupDir).filter((name) => name.startsWith(`stations ${label} `)).sort().slice(0, -30);
      for (const name of old) fs.rmSync(path.join(backupDir, name), { force: true });
    } catch {
      // A missed copy must never stop Parlor from closing.
    }
  };
  handler.dataDir = dataDir;
  handler.phoneEnabled = () => phoneConfig().enabled;
  handler.phonePort = PHONE_PORT;

  handler.dispose = () => {
    for (const child of children) child.kill();
    for (const control of active.values()) control.abort();
  };
  return handler;
}

/** Vite dev server wrapper. */
export function parlorApi() {
  return {
    name: "parlor-api",
    configureServer(server) {
      server.middlewares.use(createParlorHandler({ store: "store-dev", dataDir: process.env.VAYAVIEW_DATA || undefined }));
    },
  };
}
