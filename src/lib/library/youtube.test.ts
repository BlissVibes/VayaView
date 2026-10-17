import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestStations } from "./suggest.ts";
import { youtubeFilm, type Video } from "./youtube.ts";
import type { Film } from "./types.ts";

const video = (id: string, extra: Partial<Video> = {}): Video => ({
  id,
  title: `Video ${id}`,
  duration: 600,
  views: 1000,
  channel: "Jerma985",
  channelUrl: "https://www.youtube.com/channel/UCK3kaNXbB57CLcyhtccV_yw",
  uploaded: 0,
  ...extra,
});

describe("youtubeFilm", () => {
  it("makes a film the schedule can air and the picture hands to YouTube", () => {
    const film = youtubeFilm(video("t9OC2ToZIQ0", { title: "Yearly Channel Doctor's Appointment", duration: 554 }));
    assert.deepEqual(film, {
      id: "yt-t9OC2ToZIQ0",
      title: "Yearly Channel Doctor's Appointment",
      year: 0,
      durationMs: 554_000,
      director: "",
      genres: ["YouTube", "Jerma985"],
      keywords: [],
      collection: "Jerma985",
      synopsis: "",
      scenes: [],
      filePath: "youtube:t9OC2ToZIQ0",
      metadataId: null,
      youtubeId: "t9OC2ToZIQ0",
      direct: true,
    });
  });

  it("takes the year from the upload time when a listing gave one", () => {
    assert.equal(youtubeFilm(video("a", { uploaded: 1707157305 })).year, 2024);
  });
});

describe("suggestStations with YouTube videos", () => {
  const movie = (id: string): Film => ({
    id,
    title: id,
    year: 1999,
    durationMs: 90 * 60_000,
    director: "",
    genres: ["Movie", "Horror"],
    keywords: [],
    collection: null,
    synopsis: "",
    scenes: [],
    filePath: `/x/${id}.mkv`,
    metadataId: null,
  });

  it("never counts them as movies, shorts or shows", () => {
    // Short YouTube videos from a channel called "Movie" still are not Movies or Shorts.
    const youtube = Array.from({ length: 8 }, (_, i) => youtubeFilm(video(`v${i}`, { duration: 300, channel: "Movie" })));
    const suggestions = suggestStations([movie("m1"), movie("m2"), ...youtube], []);
    for (const item of suggestions) assert.ok(item.mediaIds.every((id) => !id.startsWith("yt-")), `${item.name} took a YouTube video`);
    assert.equal(suggestions.find((item) => item.key === "starters-movies")?.mediaIds.length, 2);
    assert.equal(suggestions.find((item) => item.key === "starters-shorts"), undefined);
  });

  it("suggests nothing from YouTube videos alone", () => {
    const youtube = Array.from({ length: 12 }, (_, i) => youtubeFilm(video(`v${i}`)));
    assert.deepEqual(suggestStations(youtube, []), []);
  });
});
