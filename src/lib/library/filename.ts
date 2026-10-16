/**
 * Filename → title + year only.
 *
 * This cannot know that a file is horror. "Lantern.Night.2019.1080p.mkv" does
 * not contain a genre, a director, or a franchise. Those come from a metadata
 * hit (TMDB, TVDB, a Jellyfin/Kodi NFO) or from a tag the user sets by hand.
 * See CLAUDE.md.
 */

const NOISE = new Set([
  "1080p",
  "720p",
  "2160p",
  "480p",
  "4k",
  "uhd",
  "hdr",
  "sdr",
  "10bit",
  "8bit",
  "bluray",
  "bdrip",
  "brrip",
  "webrip",
  "webdl",
  "hdtv",
  "dvdrip",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "aac",
  "dts",
  "truehd",
  "atmos",
  "eac3",
  "ac3",
  "flac",
  "remux",
  "proper",
  "repack",
  "extended",
  "unrated",
  "theatrical",
  "hybrid",
  "amzn",
  "nf",
  "dsnp",
  "hmax",
  "atvp",
  "yify",
  "rarbg",
  "mkv",
  "mp4",
  "avi",
  "m4v",
]);

export type FilenameGuess = {
  title: string | null;
  year: number | null;
};

export function parseReleaseName(filename: string): FilenameGuess {
  const base = filename.replace(/^.*[/\\]/, "").replace(/\.[a-z0-9]{2,4}$/i, "");
  const spaced = base
    .replace(/[._]+/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const raw = spaced.split(" ").filter(Boolean);

  let year: number | null = null;
  const titleTokens: string[] = [];
  for (const token of raw) {
    if (!year && /^(19|20)\d{2}$/.test(token)) {
      const value = Number(token);
      if (value >= 1888 && value <= 2035) {
        year = value;
        break;
      }
    }
    if (!NOISE.has(token.toLowerCase())) titleTokens.push(token);
  }

  const title = titleTokens.join(" ").trim();
  return { title: title.length > 0 ? title : null, year };
}

/** A realistic release name for a preview film, so the library can show one. */
export function sampleReleaseName(title: string, year: number): string {
  const stem = title
    .replace(/&/g, "and")
    .replace(/[^a-zA-Z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `${stem}.${year}.1080p.BluRay.x264.mkv`;
}
