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
 *   GET  /subs/:id?s=&t=         one subtitle track as WebVTT, streamed from that offset
 *
 * Schedule math is not in here. See src/lib/schedule/engine.ts.
 */
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  // The dev server keeps its own store, so testing never overwrites the real app's stations.
  const storeDir = path.join(dataDir, options.store ?? "store");
  const backupDir = path.join(dataDir, "backups");
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  /** id -> entry, rebuilt on every scan. /media only serves what is in here. */
  let index = new Map();
  let scanning = null;
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
      index.set(id, { file, ext, vcodec: entry.vcodec, sidecars: sidecars.map((sub) => sub.file) });
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
    return { folders: roots, films, ffprobe: ffprobeOk, platform: process.platform };
  }

  /** True when ffmpeg can really encode with these settings on this machine. */
  const works = (args) =>
    new Promise((resolve) =>
      execFile(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.2", ...args, "-f", "null", "-"], { timeout: 10_000, windowsHide: true }, (error) => resolve(!error)),
    );

  /**
   * Hardware encoder when the machine really has one. Tested once per kind. No B-frames, so picture
   * and sound both start at zero. NVIDIA on the PC; on a Mac, Apple's own (VideoToolbox), and for
   * the iPhone stream HEVC, which the phone plays natively at half the size.
   */
  function encoder(kind = "file") {
    encoderArgs ??= new Map();
    if (!encoderArgs.has(kind)) {
      const nvenc = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-bf", "0", "-pix_fmt", "yuv420p"];
      const vtH264 = ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-maxrate", "12M", "-bufsize", "16M", "-realtime", "1", "-bf", "0", "-pix_fmt", "yuv420p"];
      const vtHevc = ["-c:v", "hevc_videotoolbox", "-b:v", "5M", "-maxrate", "8M", "-bufsize", "10M", "-realtime", "1", "-bf", "0", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"];
      const x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-bf", "0", "-pix_fmt", "yuv420p"];
      const tries = process.platform === "darwin" ? (kind === "hls" ? [vtHevc, vtH264] : [vtH264]) : [nvenc];
      encoderArgs.set(
        kind,
        (async () => {
          for (const args of tries) if (await works(args)) return args;
          return x264;
        })(),
      );
    }
    return encoderArgs.get(kind);
  }

  function run(command, args, res) {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    children.add(child);
    child.stdout.pipe(res);
    child.on("error", () => res.destroy());
    child.on("exit", () => children.delete(child));
    res.on("close", () => child.kill());
  }

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
    const args = copy
      ? ["-v", "error", "-noaccurate_seek", "-ss", (t + 0.14).toFixed(3), "-i", entry.file]
      : ["-v", "error", "-ss", t.toFixed(3), "-i", entry.file];
    if (burn != null) args.push("-filter_complex", `[0:v:0][0:s:${burn}]overlay,scale=-2:'min(1080,ih)'[v]`, "-map", "[v]");
    else args.push("-map", "0:v:0");
    args.push("-map", `0:a:${audio}?`, "-sn");
    if (copy) args.push("-c:v", "copy", ...(entry.vcodec === "hevc" ? ["-tag:v", "hvc1"] : []));
    else {
      if (burn == null) args.push("-vf", "scale=-2:'min(1080,ih)'");
      args.push(...(await encoder()));
    }
    args.push("-c:a", "aac", "-ac", "2", "-b:a", "192k", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1");
    res.statusCode = 200;
    res.setHeader("Content-Type", "video/mp4");
    run(FFMPEG, args, res);
  }

  function sendSubs(res, entry, query) {
    const key = query.get("s") ?? "";
    const t = Math.max(0, Number(query.get("t")) || 0);
    const external = key.startsWith("x");
    const source = external ? entry.sidecars[Number(key.slice(1))] : entry.file;
    if (!source) {
      res.statusCode = 404;
      return res.end();
    }
    const map = external ? [] : ["-map", `0:s:${Math.max(0, parseInt(key, 10) || 0)}`];
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    run(FFMPEG, ["-v", "error", "-ss", String(t), "-i", source, ...map, "-f", "webvtt", "pipe:1"], res);
  }

  function sendKeyframe(res, entry, t) {
    execFile(
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
        sendJson(res, 200, { found: best != null, t: best ?? t, base: Math.max(0, (best ?? t) - delay) });
      },
    );
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

  function writeStore(key, value) {
    const file = storeFile(key);
    // Stations also get one copy per hour, taken from just before that hour's first change. The 72 newest are kept.
    if (key.startsWith("parlor.v2") && fs.existsSync(file)) {
      const copy = path.join(backupDir, `stations ${new Date().toISOString().slice(0, 13).replace("T", " ")}h.json`);
      if (!fs.existsSync(copy)) {
        try {
          fs.writeFileSync(copy, JSON.parse(fs.readFileSync(file, "utf8")).value);
          const old = fs.readdirSync(backupDir).filter((name) => name.startsWith("stations ")).sort().slice(0, -72);
          for (const name of old) fs.rmSync(path.join(backupDir, name), { force: true });
        } catch {
          // A missed hourly copy is not worth failing the save over.
        }
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

  // ---------------------------------------------------------------- TMDB
  // Genres, collections and directors, looked up once per title and kept in a file.
  // The token stays in its own file on this PC and is never sent to a phone.
  const tmdbFile = path.join(dataDir, "parlor-tmdb.json");
  const metaFile = path.join(dataDir, "parlor-metadata.json");
  const tmdb = { running: false, done: 0, total: 0, error: null };

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
    const token = readJson(tmdbFile, {}).token;
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
      hasToken: Boolean(readJson(tmdbFile, {}).token),
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
    // Wait for ffmpeg to actually stop before removing what it was writing.
    if (session.child.exitCode == null) session.child.once("exit", () => clearDir(session.dir));
    else clearDir(session.dir);
    session.child.kill();
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
    const args = copy
      ? ["-v", "error", "-noaccurate_seek", "-ss", (t + 0.14).toFixed(3)]
      : ["-v", "error", "-ss", t.toFixed(3)];
    // Read about as fast as it is watched, after a head start, so a whole film is never copied to disk at once.
    args.push("-readrate", "1.5", "-readrate_initial_burst", "40", "-i", entry.file);
    if (burn != null) args.push("-filter_complex", `[0:v:0][0:s:${burn}]overlay,scale=-2:'min(1080,ih)'[v]`, "-map", "[v]");
    else args.push("-map", "0:v:0");
    args.push("-map", `0:a:${audio}?`, "-sn");
    if (copy) args.push("-c:v", "copy", ...(entry.vcodec === "hevc" ? ["-tag:v", "hvc1"] : []));
    else {
      if (burn == null) args.push("-vf", "scale=-2:'min(1080,ih)'");
      args.push(...(await encoder("hls")), "-g", "96");
    }
    args.push(
      "-c:a", "aac", "-ac", "2", "-b:a", "192k",
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "event",
      "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", "seg%05d.m4s", "index.m3u8",
    );
    // Run inside the session folder: ffmpeg puts the init piece in its working folder, whatever the playlist path says.
    const child = spawn(FFMPEG, args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    children.add(child);
    child.on("exit", () => children.delete(child));
    return { dir, child, lastHit: Date.now() };
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
        // The same phone moved on: let its previous stream finish its last requests, then stop it.
        const phone = sid.split("-")[0];
        for (const other of hlsSessions.keys()) if (other !== sid && other.split("-")[0] === phone) setTimeout(() => endHls(other), 5000);
        session = { ...(await startHls(sid, entry, query)), key };
        hlsSessions.set(sid, session);
      }
    }
    if (!session) {
      res.statusCode = 404;
      return res.end();
    }
    session.lastHit = Date.now();
    const target = path.join(session.dir, file);
    // The first pieces take a moment to appear.
    for (let i = 0; i < 75; i++) {
      if (fs.existsSync(target) && (file !== "index.m3u8" || /#EXTINF/.test(fs.readFileSync(target, "utf8")))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
    fs.createReadStream(target).pipe(res);
  }

  async function handler(req, res, next) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const part = url.pathname.split("/");

    if (url.pathname === "/api/library" && req.method === "GET") {
      scanning ??= scan().finally(() => (scanning = null));
      try {
        return sendJson(res, 200, await scanning);
      } catch (error) {
        status.phase = "idle";
        return sendJson(res, 500, { error: String(error) });
      }
    }
    if (url.pathname === "/api/status") return sendJson(res, 200, status);

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
        return fs.createReadStream(file).pipe(res);
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
    if (url.pathname === "/api/store") {
      if (req.method === "GET") return sendJson(res, 200, readStore());
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
      fs.writeFileSync(configFile, JSON.stringify({ folders: wanted }, null, 2));
      return sendJson(res, 200, { folders: wanted });
    }

    if (part[1] === "media" || part[1] === "subs" || (part[1] === "api" && part[2] === "keyframe")) {
      const entry = index.get(part[part.length - 1]);
      if (!entry) {
        res.statusCode = 404;
        return res.end();
      }
      if (part[1] === "subs") return sendSubs(res, entry, url.searchParams);
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
      /^\/api\/(phone|config|pick-folder|tmdb\/token|tmdb\/lookup|pair|update)/.test(url.pathname) ||
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
  };
  return handler;
}

/** Vite dev server wrapper. */
export function parlorApi() {
  return {
    name: "parlor-api",
    configureServer(server) {
      server.middlewares.use(createParlorHandler({ store: "store-dev" }));
    },
  };
}
