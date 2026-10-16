/**
 * A film the schedule can air.
 * Tags are filled by a metadata match (or by hand), never by guessing from the
 * filename. `filePath` is null in this preview; the desktop port sets it.
 */
export type AudioTrack = { codec: string; lang: string; title: string; ch: number };

/**
 * `key` is the track's position among the file's subtitle streams, or `x0`,
 * `x1`… for a subtitle file sitting next to the video. Picture-based tracks
 * (`text: false`) can only be shown by burning them into the picture.
 */
export type SubTrack = { key: string; lang: string; title: string; text: boolean };

export type Film = {
  id: string;
  title: string;
  year: number;
  durationMs: number;
  director: string;
  genres: string[];
  keywords: string[];
  /** Franchise / series name. Null when the film is not in a collection. */
  collection: string | null;
  synopsis: string;
  /** Evenly spaced picture captions so a mid-film join still has a scene. */
  scenes: string[];
  filePath: string | null;
  /** Provider id once identified, for example a TMDB id. */
  metadataId: string | null;
  /** Name on disk, when the film came from a scan. */
  fileName?: string;
  /** False when the browser cannot take the codecs and one ffmpeg session is needed. */
  direct?: boolean;
  vcodec?: string;
  /** Episode numbering, when the filename gave one. Season 0 means the show counts straight through (anime style). */
  season?: number;
  episode?: number;
  /** The show counts episodes straight through, anime style. `episode` is the running number. */
  absolute?: boolean;
  audio?: AudioTrack[];
  subs?: SubTrack[];
};
