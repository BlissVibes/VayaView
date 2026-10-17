import { addYoutubeFilms, fillSchedule, isDiskLibrary, setDiskLibrary, youtubeFilms } from "./catalog.ts";
import type { Film } from "./types.ts";

/**
 * A YouTube video as the server keeps it (server/youtube.mjs). `duration` is in seconds, `uploaded`
 * is a Unix time in seconds, or 0 when a listing did not say (flat listings usually do not).
 */
export type Video = { id: string; title: string; duration: number; views: number; channel: string; channelUrl: string; uploaded: number };

/** The catalogue id of a YouTube video. Disk ids are hashes, so the prefix keeps the two apart. */
export const youtubeMediaId = (videoId: string) => `yt-${videoId}`;

/**
 * A YouTube video as a film the schedule can air. It is never on disk: `filePath` is a stand-in so
 * the picture's seek and pause controls treat it as playable, and the picture hands it to YouTube's
 * own player instead of opening a file. Its genres put it apart from Movies and Shorts.
 */
export function youtubeFilm(video: Video): Film {
  return {
    id: youtubeMediaId(video.id),
    title: video.title,
    year: video.uploaded > 0 ? new Date(video.uploaded * 1000).getUTCFullYear() : 0,
    durationMs: Math.round(video.duration * 1000),
    director: "",
    genres: ["YouTube", video.channel].filter(Boolean),
    keywords: [],
    collection: video.channel || null,
    synopsis: "",
    scenes: [],
    filePath: `youtube:${video.id}`,
    metadataId: null,
    youtubeId: video.id,
    direct: true,
  };
}

function isVideo(value: unknown): value is Video {
  const video = value as Video;
  return Boolean(video) && typeof video.id === "string" && typeof video.title === "string" && Number(video.duration) > 0;
}

/**
 * The YouTube videos stations have used, into the catalogue. Called once at boot, after the disk
 * library. With no folders chosen the catalogue still holds the preview films; YouTube stations
 * are real, so the preview gives way to an empty disk library first.
 */
export async function loadYoutubeLibrary(): Promise<void> {
  let videos: Video[] = [];
  try {
    const response = await fetch("/api/youtube/library");
    if (!response.ok) return;
    const data = (await response.json()) as { videos?: Record<string, unknown> };
    videos = Object.values(data.videos ?? {}).filter(isVideo);
  } catch {
    return;
  }
  if (videos.length === 0) return;
  if (!isDiskLibrary()) setDiskLibrary([], []);
  addYoutubeFilms(videos.map(youtubeFilm));
}

/**
 * Keep these videos (the server writes them to Data\parlor-youtube.json) and put them in the
 * catalogue now, so a station made from them airs at once, without a reload.
 */
export async function rememberYoutube(videos: readonly Video[]): Promise<void> {
  if (videos.length === 0) return;
  const response = await fetch("/api/youtube/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
  });
  if (!response.ok) throw new Error("The YouTube videos could not be saved.");
  if (!isDiskLibrary()) setDiskLibrary([], []);
  addYoutubeFilms(videos.map(youtubeFilm));
  fillSchedule();
}

/** True once any YouTube video is in the catalogue. */
export const hasYoutube = () => youtubeFilms.length > 0;
