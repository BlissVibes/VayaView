/**
 * YouTube stations. Videos are found with yt-dlp (listings, search, and each video's "most
 * replayed" curve) and played through YouTube's own embedded player, never downloaded.
 *
 *   GET  /api/youtube/status                  { ytdlp: bool, version }
 *   GET  /api/youtube/find?q=                 channels matching a name, @handle or URL
 *   GET  /api/youtube/channel?url=            a channel: its videos (newest 80) and the kinds of station they make
 *   GET  /api/youtube/side?url=&name=         other channels that look like the same person's (vlogs, music, clips…)
 *   GET  /api/youtube/list?url=               the videos of a playlist, a channel tab, or "ytsearch30:words"
 *   GET  /api/youtube/video/:id               one video's most-replayed peaks and chapters (cached for a month)
 *   GET  /api/youtube/library                 every YouTube video a station has used
 *   POST /api/youtube/library { videos }      remember videos, so the library can air them
 *
 * yt-dlp is optional, like ffmpeg: `brew install yt-dlp` on a Mac, `winget install yt-dlp` on Windows.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SHORT_S = 61;
const LONG_S = 60 * 60;
const COMPILATION = /\b(compilation|best of|funniest|funny moments|moments|highlights|clips|montage|supercut)\b/i;

/** Ways a creator's work usually splits, searched for beside the main channel. */
const SIDE_KINDS = [
  ["vlogs", "vlog"],
  ["music", "music"],
  ["clips", "clips"],
  ["second channel", "second channel"],
  ["podcast", "podcast"],
  ["short films", "short film"],
  ["streams", "vod"],
  ["reacts", "reacts"],
];

export function createYoutube({ dataDir, findTool, pool }) {
  const YTDLP = findTool("yt-dlp");
  const cacheFile = path.join(dataDir, "youtube-cache.json");
  const libraryFile = path.join(dataDir, "parlor-youtube.json");
  const cache = readJson(cacheFile, {});
  let version = null;

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }
  let saveTimer = null;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
      } catch {
        // Nowhere to write; carry on.
      }
    }, 500);
  }

  /** yt-dlp as JSON. Listings are flat (one call for a whole page), so no video is opened for a list. */
  function ytdlp(args, { timeout = 90_000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(YTDLP, ["--no-warnings", "--ignore-config", "-J", ...args], { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          if (error.code === "ENOENT") return reject(new Error("yt-dlp is not installed. On a Mac: brew install yt-dlp. On Windows: winget install yt-dlp."));
          const line = String(stderr ?? "").split("\n").find((text) => /ERROR/.test(text)) ?? error.message;
          return reject(new Error(line.replace(/^ERROR:\s*/, "").slice(0, 300)));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("yt-dlp gave an answer that could not be read."));
        }
      });
    });
  }

  async function cached(key, ttlMs, make) {
    const hit = cache[key];
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await make();
    cache[key] = { at: Date.now(), value };
    saveCache();
    return value;
  }

  async function status() {
    if (version === null) {
      version = await new Promise((resolve) => execFile(YTDLP, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout).trim())));
    }
    return { ytdlp: Boolean(version), version: version || null };
  }

  /** The bits of a flat entry a station needs. Null for live streams and anything without a length. */
  function video(entry, extra = {}) {
    const duration = Number(entry?.duration) || 0;
    if (!entry?.id || duration <= 0 || entry.live_status === "is_live" || entry.live_status === "is_upcoming") return null;
    return {
      id: String(entry.id),
      title: String(entry.title ?? "").trim() || String(entry.id),
      duration,
      views: Number(entry.view_count) || 0,
      channel: String(entry.channel ?? entry.uploader ?? extra.channel ?? "").trim(),
      channelUrl: String(entry.channel_url ?? entry.uploader_url ?? extra.channelUrl ?? ""),
      uploaded: Number(entry.timestamp) || 0,
    };
  }

  const channelUrlOf = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    if (/^@[\w.-]+$/.test(text)) return `https://www.youtube.com/${text}`;
    if (/^UC[\w-]{20,}$/.test(text)) return `https://www.youtube.com/channel/${text}`;
    const url = /^(https?:\/\/)?(www\.|m\.)?youtube\.com\/(@[\w.-]+|channel\/UC[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/i.exec(text);
    if (url) return `https://www.youtube.com/${url[3]}`;
    return null;
  };

  /** Channels for a name, @handle or URL. A name is searched; the channels its results come from are offered, most frequent first. */
  async function find(q) {
    const direct = channelUrlOf(q);
    if (direct) {
      const page = await listPage(`${direct}/videos`, 12);
      return { channels: [{ name: page.channel, url: page.channelUrl, handle: page.handle, sample: page.videos.slice(0, 3).map((item) => item.title), count: null }] };
    }
    // A name is very often also the handle ("Jerma985" is @Jerma985, "Corridor Digital" is @CorridorDigital). A search
    // for it can miss the channel itself under pages of fan uploads, so the handle is tried beside the search.
    const guess = /^[\w .-]{3,40}$/.test(q) ? `https://www.youtube.com/@${q.replace(/\s+/g, "")}` : null;
    const [results, own] = await Promise.all([listPage(`ytsearch25:${q}`, 25), guess ? listPage(`${guess}/videos`, 12).catch(() => null) : null]);
    const byChannel = new Map();
    if (own?.channelUrl && own.videos.length > 0) {
      byChannel.set(own.channelUrl, { name: own.channel, url: own.channelUrl, handle: own.handle, sample: own.videos.slice(0, 3).map((item) => item.title), count: null, exact: true });
    }
    for (const item of results.videos) {
      if (!item.channelUrl) continue;
      const hit = byChannel.get(item.channelUrl) ?? { name: item.channel, url: item.channelUrl, handle: null, sample: [], count: 0 };
      if (hit.exact) continue;
      hit.count += 1;
      if (hit.sample.length < 3) hit.sample.push(item.title);
      byChannel.set(item.channelUrl, hit);
    }
    const wanted = q.toLowerCase().replace(/[^a-z0-9]/g, "");
    const channels = [...byChannel.values()].sort((a, b) => {
      const exactA = a.exact || a.name.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted ? 1 : 0;
      const exactB = b.exact || b.name.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted ? 1 : 0;
      return exactB - exactA || (b.count ?? 0) - (a.count ?? 0);
    });
    return { channels: channels.slice(0, 6).map(({ exact, ...hit }) => hit) };
  }

  /** A playlist, a channel tab, or a search, as videos. */
  async function listPage(url, limit = 80) {
    return cached(`list:${url}:${limit}`, 12 * 60 * 60_000, async () => {
      const data = await ytdlp(["--flat-playlist", "--playlist-items", `1:${limit}`, url]);
      const entries = Array.isArray(data?.entries) ? data.entries : data?.id ? [data] : [];
      const channel = String(data?.channel ?? data?.uploader ?? "").trim();
      const channelUrl = String(data?.channel_url ?? data?.uploader_url ?? "");
      const handle = /youtube\.com\/(@[\w.-]+)/.exec(String(data?.uploader_url ?? data?.webpage_url ?? ""))?.[1] ?? null;
      return {
        title: String(data?.title ?? ""),
        channel,
        channelUrl,
        handle,
        description: String(data?.description ?? "").slice(0, 4000),
        videos: entries.map((entry) => video(entry, { channel, channelUrl })).filter(Boolean),
      };
    });
  }

  /** The channel's playlists: name, id, size. */
  async function playlists(channelUrl) {
    return cached(`playlists:${channelUrl}`, 12 * 60 * 60_000, async () => {
      try {
        const data = await ytdlp(["--flat-playlist", "--playlist-items", "1:40", `${channelUrl}/playlists`]);
        return (data?.entries ?? [])
          .filter((entry) => entry?.id && /^(PL|OL|UU|RD)/.test(String(entry.id)))
          .map((entry) => ({ id: String(entry.id), title: String(entry.title ?? "").trim(), count: Number(entry.playlist_count) || null, url: `https://www.youtube.com/playlist?list=${entry.id}` }))
          .filter((item) => item.title && !/^(uploads|liked videos|watch later)$/i.test(item.title));
      } catch {
        return [];
      }
    });
  }

  /**
   * A channel, and the kinds of station its videos make: everything it uploads, the long ones,
   * the compilations (its own, and the ones other people cut from it), and each playlist. Each kind
   * carries a `url` that /api/youtube/list turns into the actual videos when a station is made.
   */
  async function channel(url) {
    const base = channelUrlOf(url);
    if (!base) throw new Error("That is not a YouTube channel.");
    const page = await listPage(`${base}/videos`, 80);
    const name = page.channel || base;
    const videos = page.videos.filter((item) => item.duration >= SHORT_S);
    const long = videos.filter((item) => item.duration >= LONG_S);
    const compilations = videos.filter((item) => COMPILATION.test(item.title));
    const kinds = [];
    const kind = (key, label, count, source, note = "") => kinds.push({ key, label, count, url: source, note });
    kind("uploads", "Uploads", videos.length, `${base}/videos`, "the newest 80, shorts left out");
    if (long.length >= 3) kind("long", "Long videos", long.length, `${base}/videos#long`, "an hour or more: streams, full playthroughs");
    if (compilations.length >= 3) kind("compilations", "Compilations", compilations.length, `${base}/videos#compilations`, "best-ofs and moments it uploads itself");
    kind("fan-compilations", `${name} compilations across YouTube`, null, `ytsearch40:${name} compilation`, "cut by other channels; checked when the station is made");
    const lists = await playlists(base);
    for (const list of lists.slice(0, 25)) kind(`playlist:${list.id}`, list.title, list.count, list.url, "a playlist on the channel");
    return { name, url: base, handle: page.handle, description: page.description, videos, kinds };
  }

  /**
   * Channels that look like the same person's other outlets. Two sources: links in the channel's own
   * description (the surest), and searches for the name beside "vlog", "music", "clips" and so on,
   * counting which other channels keep turning up.
   */
  async function side(url, name) {
    const base = channelUrlOf(url);
    if (!base) throw new Error("That is not a YouTube channel.");
    const page = await listPage(`${base}/videos`, 80);
    const who = (name || page.channel || "").trim();
    // The channel goes by several addresses: the one asked about (often its @handle), its /channel/UC… id, and its handle.
    // Search results name it by the UC… one, so all of them count as "this channel", not as a side channel.
    const own = new Set([base, page.channelUrl, page.handle ? `https://www.youtube.com/${page.handle}` : ""].filter(Boolean));
    const found = new Map();
    const note = (channelUrl, channelName, reason, title) => {
      if (!channelUrl || own.has(channelUrl)) return;
      const hit = found.get(channelUrl) ?? { name: channelName, url: channelUrl, count: 0, reasons: new Set(), sample: [] };
      hit.count += 1;
      hit.reasons.add(reason);
      if (title && hit.sample.length < 3 && !hit.sample.includes(title)) hit.sample.push(title);
      found.set(channelUrl, hit);
    };
    for (const link of page.description.matchAll(/youtube\.com\/(@[\w.-]+|channel\/UC[\w-]+)/g)) {
      const linked = `https://www.youtube.com/${link[1]}`;
      note(linked, link[1], "linked from the channel page", "");
    }
    if (who) {
      await pool(SIDE_KINDS, 3, async ([reason, word]) => {
        try {
          const results = await listPage(`ytsearch12:${who} ${word}`, 12);
          const stem = who.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
          for (const item of results.videos) {
            // Only channels whose name shares a stem with the creator's, or that are named in the video title: fans and strangers are left out.
            const channelStem = item.channel.toLowerCase().replace(/[^a-z0-9]/g, "");
            const related = stem && (channelStem.includes(stem) || item.title.toLowerCase().includes(who.toLowerCase()));
            if (related) note(item.channelUrl, item.channel, reason, item.title);
          }
        } catch {
          // One search failing is not worth stopping for.
        }
      });
    }
    const channels = [...found.values()]
      .map((hit) => ({ ...hit, reasons: [...hit.reasons] }))
      .sort((a, b) => Number(b.reasons.includes("linked from the channel page")) - Number(a.reasons.includes("linked from the channel page")) || b.count - a.count)
      .slice(0, 8);
    return { channels };
  }

  /** The videos behind a kind's url. `#long` and `#compilations` filter the channel's uploads. */
  async function list(url) {
    const [source, filter] = String(url).split("#");
    const page = await listPage(source, /ytsearch/.test(source) ? 40 : 80);
    let videos = page.videos.filter((item) => item.duration >= SHORT_S);
    if (filter === "long") videos = videos.filter((item) => item.duration >= LONG_S);
    if (filter === "compilations") videos = videos.filter((item) => COMPILATION.test(item.title));
    return { title: page.title, channel: page.channel, videos };
  }

  /** One video's most-replayed curve as peaks (seconds), highest first, plus its chapters. */
  async function detail(id) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error("That is not a YouTube video id.");
    return cached(`video:${id}`, 30 * 24 * 60 * 60_000, async () => {
      const data = await ytdlp(["--no-playlist", `https://www.youtube.com/watch?v=${id}`], { timeout: 60_000 });
      const heat = Array.isArray(data?.heatmap) ? data.heatmap : [];
      // A peak is a stretch above its neighbours. Keep the eight highest, at least 45 s apart. The opening stretch is
      // left out: it is high on nearly every video only because that is where everyone starts watching.
      const points = heat
        .map((item) => ({ t: Number(item.start_time) || 0, v: Number(item.value) || 0 }))
        .filter((point) => point.t > 0)
        .sort((a, b) => b.v - a.v);
      const peaks = [];
      for (const point of points) {
        if (peaks.some((peak) => Math.abs(peak.t - point.t) < 45)) continue;
        peaks.push(point);
        if (peaks.length >= 8) break;
      }
      return {
        id,
        title: String(data?.title ?? ""),
        duration: Number(data?.duration) || 0,
        peaks: peaks.map((peak) => ({ t: Math.round(peak.t), v: Number(peak.v.toFixed(3)) })),
        chapters: (data?.chapters ?? []).map((chapter) => ({ t: Math.round(Number(chapter.start_time) || 0), title: String(chapter.title ?? "") })).slice(0, 60),
        embeddable: data?.playable_in_embed !== false,
      };
    });
  }

  // The videos stations have used: id, title, length, channel. The app's library airs these.
  function readLibrary() {
    const saved = readJson(libraryFile, { videos: {} });
    return saved && typeof saved.videos === "object" && saved.videos ? saved : { videos: {} };
  }
  function remember(videos) {
    const library = readLibrary();
    for (const item of videos) {
      const clean = video({ id: item.id, title: item.title, duration: item.duration, view_count: item.views, channel: item.channel, channel_url: item.channelUrl, timestamp: item.uploaded });
      if (clean) library.videos[clean.id] = clean;
    }
    fs.writeFileSync(libraryFile, JSON.stringify(library));
    return library;
  }

  const sendJson = (res, code, body) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(text || "null"));
        } catch {
          resolve(null);
        }
      });
    });

  /** Routes under /api/youtube. Returns false when the path is not one of them. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/youtube")) return false;
    const part = url.pathname.split("/");
    const q = (key) => (url.searchParams.get(key) ?? "").trim();
    try {
      if (url.pathname === "/api/youtube/status") return sendJson(res, 200, await status()), true;
      if (url.pathname === "/api/youtube/library" && req.method === "GET") return sendJson(res, 200, readLibrary()), true;
      if (url.pathname === "/api/youtube/library" && req.method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 200, remember(Array.isArray(body?.videos) ? body.videos : [])), true;
      }
      if (url.pathname === "/api/youtube/find") {
        if (!q("q")) return sendJson(res, 400, { error: "Type a name, @handle or channel link." }), true;
        return sendJson(res, 200, await find(q("q").slice(0, 200))), true;
      }
      if (url.pathname === "/api/youtube/channel") return sendJson(res, 200, await channel(q("url"))), true;
      if (url.pathname === "/api/youtube/side") return sendJson(res, 200, await side(q("url"), q("name"))), true;
      if (url.pathname === "/api/youtube/list") {
        const source = q("url");
        if (!/^(https:\/\/www\.youtube\.com\/|ytsearch\d*:)/.test(source)) return sendJson(res, 400, { error: "That is not a YouTube list." }), true;
        return sendJson(res, 200, await list(source.slice(0, 500))), true;
      }
      if (part[3] === "video" && part[4]) return sendJson(res, 200, await detail(part[4])), true;
      return sendJson(res, 404, { error: "Not found" }), true;
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }), true;
    }
  }

  return { handle, status, find, channel, side, list, detail, readLibrary };
}
