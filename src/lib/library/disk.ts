import { libraryInfo, setDiskLibrary } from "./catalog.ts";
import { isRemote } from "../remote.ts";
import type { AudioTrack, Film, SubTrack } from "./types.ts";

type DiskFile = {
  id: string;
  path: string;
  rel: string;
  durationMs: number;
  vcodec: string;
  width: number;
  height: number;
  size: number;
  direct: boolean;
  missing: boolean;
  audio: AudioTrack[];
  subs: SubTrack[];
};

const EPISODE = /\bS(\d{1,2})[ ._-]?EP?(\d{1,3})\b|\b(\d{1,2})x(\d{2,3})\b/i;
/** A season pack folder: `Show.2005.S04.1080p…`, `Show Season 2`, or a bare `Season 05`. Group 1 is the show. */
const SEASON_DIR = /^(.*?)(?:^|[ ._-]+)(?:S(\d{1,2})(?![\dEe])|Season[ ._-]?(\d{1,2}))(?!\d)/i;
/** Where an episode's own name ends and the release details begin. */
const NAME_STOP =
  /^(\d{3,4}p|4k|uhd|hdr|hdr10|dv|sdr|bluray|blu-ray|brrip|bdrip|webrip|web|web-dl|webdl|hdtv|dvdrip|x26[45]|h26[45]|h|hevc|avc|av1|remux|10bit|8bit|proper|repack|internal|amzn|nf|hmax|dsnp|atvp|hulu|ddp5|ddp|dd5|aac|aac5|ac3|eac3|dts|atmos|truehd|dual|multi|mp4|mkv)$/i;
/** Anime style: `Show - 012 - Title`, with or without a [group] tag in front. */
const ABSOLUTE = /^(?:\[[^\]]*\]\s*)*(.+?)\s-\s(\d{2,4})(?=\s-\s|\s*[[(]|\s*(?:v\d)?\.\w{2,4}$)/i;
const EXTRAS = /(^|[\\/])(extras?|featurettes?|samples?|trailers?|behind the scenes|deleted scenes|bonus)([\\/]|$)|\bsample\b/i;
const TV_FOLDER = /tv.?shows?|series/i;
const RELEASE_NOISE = /^(\d{3,4}p|4k|uhd|bluray|brrip|bdrip|webrip|web|web-dl|webdl|hdtv|dvdrip|x26[45]|h26[45]|hevc|remux|hdr|10bit|yts|extended|unrated|remastered)$/i;
/** Under this, a file that is not an episode is a clip, not a film. */
const SHORT_MS = 45 * 60_000;
/** Under this it is a menu loop, a sample or a logo. It never airs. */
const CLIP_MS = 2 * 60_000;
const CAM = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine)\b|hd-ts/i;

/**
 * How good a copy is, for choosing between two files of the same film.
 * On disk beats missing. A proper release beats a cinema recording. Then
 * resolution, then bitrate, with HEVC and AV1 counted as worth more per bit.
 */
function quality(file: DiskFile): number {
  const tier = file.width >= 3000 ? 4 : file.width >= 1800 ? 3 : file.width >= 1200 ? 2 : 1;
  const efficient = file.vcodec === "hevc" || file.vcodec === "av1" ? 1.6 : 1;
  const kbps = ((file.size * 8) / Math.max(1, file.durationMs)) * efficient;
  return (file.missing ? 0 : 1e9) + (CAM.test(file.rel.replace(/[._]+/g, " ")) ? 0 : 1e8) + tier * 1e7 + Math.min(kbps, 9e6);
}

function spaced(name: string): string {
  return name
    .replace(/[._]+/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Title and year from a release name. The year is the first year-shaped word
 * that is not the first word, so `2001.A.Space.Odyssey.1968` keeps its title.
 */
export function guessTitle(name: string): { title: string; year: number } {
  const tokens = spaced(name.replace(/\.[a-z0-9]{2,4}$/i, "")).split(" ");
  const yearAt = tokens.findIndex((token, i) => i > 0 && /^(19|20)\d{2}$/.test(token));
  const noiseAt = tokens.findIndex((token, i) => i > 0 && RELEASE_NOISE.test(token));
  const end = yearAt > 0 ? yearAt : noiseAt > 0 ? noiseAt : tokens.length;
  return { title: tokens.slice(0, end).join(" "), year: yearAt > 0 ? Number(tokens[yearAt]) : 0 };
}

/**
 * The episode's own name from what follows its number: `.Heavy.Is.the.Crown.2024.1080p…`
 * → "Heavy Is the Crown". Stops at the first release detail. A trailing year goes,
 * unless it is a special's, where the year is how you tell two Christmas specials apart.
 */
function episodeName(rest: string, keepYear = false): string {
  const words: string[] = [];
  for (const token of spaced(rest.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/^[\s.\-_]+/, "")).split(" ")) {
    if (!token || NAME_STOP.test(token.split("-")[0] ?? "") || /^\[/.test(token)) break;
    words.push(token);
  }
  if (!keepYear && /^(19|20)\d{2}$/.test(words[words.length - 1] ?? "")) words.pop();
  const name = words.join(" ").replace(/^-\s*/, "").trim();
  return name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name;
}

function showFromFolder(name: string): string {
  return name
    .replace(/[._]+/g, " ")
    .replace(/[[(].*$/, "")
    .replace(/\b(S\d{1,2}\b.*|Seasons?\s*\d.*|Complete.*|\d{3,4}p.*)$/i, "")
    .replace(/[-\s]+$/, "")
    .trim();
}

function showFromPrefix(prefix: string): string {
  return spaced(prefix.replace(/[[(].*?[\])]/g, " "))
    .replace(/\s(19|20)\d{2}$/, "")
    .replace(/[-\s]+$/, "")
    .trim();
}

const pad = (n: number) => String(n).padStart(2, "0");
const showKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Files on disk → films. Title and year come from the name. An episode is a
 * file with S01E02 in it, or one of several files in a show's folder. Nothing
 * here invents a genre; that needs a metadata match. See HANDOFF.md.
 */
export function buildLibrary(files: DiskFile[]): Film[] {
  const kept = files.filter((file) => !EXTRAS.test(file.rel) && file.durationMs >= CLIP_MS);
  const source = new Map(kept.map((file) => [file.id, file]));
  const score = (film: Film) => quality(source.get(film.id)!);
  const perFolder = new Map<string, number>();
  const folderOf = (file: DiskFile) => {
    const parts = file.rel.split(/[/\\]/);
    const depth = TV_FOLDER.test(parts[0] ?? "") ? 1 : 0;
    return { inTv: depth === 1, folder: parts.length > depth + 1 ? (parts[depth] ?? null) : null, parts };
  };
  for (const file of kept) {
    const { inTv, folder } = folderOf(file);
    if (inTv && folder) perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);
  }

  const showNames = new Map<string, string>();
  const episodes = new Map<string, Film & { order: number }>();
  const movies: Film[] = [];

  /** One spelling per show, whichever folder or file named it first. */
  function nameShow(raw: string): string {
    const key = showKey(raw);
    if (!showNames.has(key)) showNames.set(key, raw === raw.toLowerCase() ? raw.replace(/\b\w/g, (c) => c.toUpperCase()) : raw);
    return showNames.get(key) ?? raw;
  }

  function addEpisode(file: DiskFile, slot: string, film: Omit<Film, "year" | "genres"> & { order: number }) {
    const rival = episodes.get(slot);
    if (rival && score(rival) >= quality(file)) return;
    episodes.set(slot, { ...film, year: 0, genres: ["TV"] });
  }

  /** An episode with no number: a Christmas special, a one-off. Named by what is left after the show's name. */
  function addSpecial(file: DiskFile, base: Omit<Film, "title" | "year" | "genres" | "collection">, show: string, season: number) {
    const showWords = new Set(spaced(show).toLowerCase().split(" "));
    const tokens = spaced((base.fileName ?? "").replace(/\.[a-z0-9]{2,4}$/i, "")).split(" ");
    let start = 0;
    while (start < tokens.length && showWords.has((tokens[start] ?? "").toLowerCase())) start += 1;
    // The year that dates the show ("Doctor Who 2005") is part of its name, not the special's.
    if (start > 0 && /^(19|20)\d{2}$/.test(tokens[start] ?? "")) start += 1;
    const name = episodeName(tokens.slice(start).join(" "), true) || "Special";
    const label = /special/i.test(name) ? name : `Special · ${name}`;
    addEpisode(file, `${showKey(show)}|special|${name.toLowerCase().replace(/special|[^a-z0-9]/g, "")}`, {
      ...base,
      title: `${show}${season > 0 ? ` S${pad(season)}` : ""} · ${label}`,
      collection: show,
      order: season * 1000 + 900,
    });
  }

  for (const file of kept) {
    const { inTv, folder, parts } = folderOf(file);
    const fileName = parts[parts.length - 1] ?? file.rel;
    const base = {
      id: file.id,
      durationMs: file.durationMs,
      director: "",
      keywords: [],
      synopsis: "",
      scenes: [],
      filePath: file.path,
      metadataId: null,
      fileName,
      direct: file.direct,
      vcodec: file.vcodec,
      audio: file.audio,
      subs: file.subs,
    };

    const absolute = EPISODE.test(fileName) ? null : ABSOLUTE.exec(fileName);
    const match = absolute ? null : EPISODE.exec(fileName);
    // A season pack's folder ("Show.2005.S04.1080p…") names the show and season even when the file inside does not.
    const pack = parts.slice(0, -1).reverse().map((dir) => SEASON_DIR.exec(dir)).find((hit) => hit != null) ?? null;
    const packShow = pack ? showFromPrefix(pack[1] ?? "").replace(/[-\s]*\b(complete|collection)\b.*$/i, "").trim() : "";
    const looseEpisode = !match && !absolute && (pack != null || (inTv && folder != null && (perFolder.get(folder) ?? 0) >= 3));
    if (match || absolute || looseEpisode) {
      const raw =
        packShow ||
        (absolute ? showFromPrefix(absolute[1] ?? "") : match ? showFromPrefix(fileName.slice(0, match.index)) : "") ||
        showFromFolder(folder ?? "") ||
        "Unsorted";
      const show = nameShow(raw);
      if (absolute) {
        const episode = Number(absolute[2]);
        const name = episodeName(fileName.slice(absolute[0].length));
        addEpisode(file, `${showKey(show)}|abs|${episode}`, {
          ...base,
          title: `${show} · Episode ${episode}${name ? ` · ${name}` : ""}`,
          collection: show,
          order: episode,
          episode,
          absolute: true,
        });
      } else if (match) {
        const season = Number(match[1] ?? match[3]);
        const episode = Number(match[2] ?? match[4]);
        const name = episodeName(fileName.slice(match.index + match[0].length));
        // Two copies of the same episode are one slot, not two. The better copy airs.
        addEpisode(file, `${showKey(show)}|${season}|${episode}`, {
          ...base,
          title: `${show} S${pad(season)}E${pad(episode)}${name ? ` · ${name}` : ""}`,
          collection: show,
          order: season * 1000 + episode,
          season,
          episode,
        });
      } else {
        addSpecial(file, base, show, pack ? Number(pack[2] ?? pack[3]) : 0);
      }
      continue;
    }

    const fromFile = guessTitle(fileName);
    const fromFolder = folder ? guessTitle(folder) : null;
    // A short file in a film's folder is a clip or an extra, so it keeps its own name.
    const guess = file.durationMs < SHORT_MS || fromFile.year || !fromFolder?.year ? fromFile : fromFolder;
    movies.push({
      ...base,
      title: guess.title || fileName,
      year: guess.year,
      genres: [file.durationMs < SHORT_MS ? "Short" : "Movie"],
      collection: null,
    });
  }

  // A "film" titled exactly like a show you have ("Doctor Who") is one of its specials.
  for (let i = movies.length - 1; i >= 0; i--) {
    const film = movies[i]!;
    const show = showNames.get(showKey(film.title));
    const file = source.get(film.id);
    if (!show || !file) continue;
    movies.splice(i, 1);
    addSpecial(file, film, show, 0);
  }

  // Several copies of one film (a 1080p and a 4K, say) are one film. Same title, same year
  // where both say, about the same length: only the best copy stays. A different cut stays too.
  const byTitle = new Map<string, Film[]>();
  for (const film of movies) byTitle.set(showKey(film.title), [...(byTitle.get(showKey(film.title)) ?? []), film]);
  movies.length = 0;
  for (const copies of byTitle.values()) {
    const chosen: Film[] = [];
    for (const film of copies.sort((a, b) => score(b) - score(a))) {
      const again = chosen.some(
        (other) =>
          (!film.year || !other.year || film.year === other.year) &&
          Math.min(film.durationMs, other.durationMs) >= 0.8 * Math.max(film.durationMs, other.durationMs),
      );
      if (!again) chosen.push(film);
    }
    movies.push(...chosen);
  }
  movies.sort((a, b) => a.title.localeCompare(b.title));
  const shows = [...episodes.values()].sort(
    (a, b) => (a.collection ?? "").localeCompare(b.collection ?? "") || a.order - b.order || a.title.localeCompare(b.title),
  );
  return [...movies, ...shows];
}

type Meta = { found: boolean; tmdbId?: string; genres?: string[]; collection?: string | null; director?: string; keywords?: string[]; overview?: string };

/** "Doctor.Who.2005.S02E01" → 2005, so TMDB is asked about the right Doctor Who. */
function showYear(show: string, films: Film[]): string {
  const words = show.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/ /g, "[ ._-]+");
  const pattern = new RegExp(`${words}[ ._-]+\\(?((?:19|20)\\d{2})`);
  for (const film of films) {
    const year = pattern.exec((film.fileName ?? "").toLowerCase())?.[1];
    if (year) return year;
  }
  return "";
}

/**
 * Lay what TMDB knows over the films: real genres, the franchise a film belongs
 * to, its director and keywords. Titles not looked up yet are queued; the PC does
 * the asking, once per title, and only when a token has been saved.
 */
async function applyMetadata(films: Film[]): Promise<void> {
  let meta: Record<string, Meta> = {};
  try {
    meta = (await (await fetch("/api/tmdb/metadata")).json()) as Record<string, Meta>;
  } catch {
    return;
  }
  const byShow = new Map<string, Film[]>();
  for (const film of films) if (film.genres[0] === "TV" && film.collection) byShow.set(film.collection, [...(byShow.get(film.collection) ?? []), film]);
  const items: (typeof libraryInfo)["metaItems"] = [];

  for (const film of films) {
    if (film.genres[0] !== "Movie") continue;
    const key = `movie|${film.title.toLowerCase()}|${film.year || ""}`;
    items.push({ key, kind: "movie", title: film.title, year: film.year || "" });
    const hit = meta[key];
    if (!hit?.found) continue;
    Object.assign(film, {
      genres: ["Movie", ...(hit.genres ?? [])],
      collection: hit.collection ?? null,
      director: hit.director ?? "",
      keywords: hit.keywords ?? [],
      synopsis: hit.overview ?? "",
      metadataId: hit.tmdbId ?? null,
    });
  }
  for (const [show, episodes] of byShow) {
    const year = showYear(show, episodes);
    const key = `tv|${show.toLowerCase()}|${year}`;
    items.push({ key, kind: "tv", title: show, year });
    const hit = meta[key];
    if (!hit?.found) continue;
    for (const film of episodes) {
      Object.assign(film, {
        genres: ["TV", ...(hit.genres ?? [])],
        director: hit.director ?? "",
        keywords: hit.keywords ?? [],
        metadataId: hit.tmdbId ?? null,
      });
    }
  }
  libraryInfo.metaItems = items;
  if (!isRemote && items.some((item) => !meta[item.key])) {
    void fetch("/api/tmdb/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) }).catch(() => {});
  }
}

/** `rescan` walks the folders again; otherwise a scan from the last ten minutes may be reused. */
export async function loadDiskLibrary(rescan = false): Promise<void> {
  libraryInfo.error = null;
  try {
    const response = await fetch(rescan ? "/api/library?rescan=1" : "/api/library");
    const data = (await response.json()) as { folders: string[]; films: DiskFile[]; ffprobe: boolean; platform?: string; error?: string };
    if (data.error) throw new Error(data.error);
    libraryInfo.folders = data.folders;
    libraryInfo.ffprobe = data.ffprobe;
    libraryInfo.platform = data.platform ?? "";
    if (data.films.length === 0) return;
    const missing = new Set(data.films.filter((file) => file.missing).map((file) => file.id));
    const films = buildLibrary(data.films);
    await applyMetadata(films);
    setDiskLibrary(
      films,
      films.filter((film) => missing.has(film.id)).map((film) => film.id),
    );
  } catch (error) {
    libraryInfo.error = error instanceof Error ? error.message : String(error);
  }
}
