import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { playRequestFor, streamSessionFor } from "./seam.ts";
import type { Airing } from "../schedule/types.ts";

describe("playRequestFor", () => {
  it("carries the live offset and the missing state, not a restart", () => {
    const airing: Airing = {
      channelId: "ch",
      cycleIndex: 3,
      slotIndex: 1,
      offsetMs: 42_000,
      remainingMs: 10,
      startedAtMs: 0,
      endsAtMs: 52_000,
      slot: { mediaId: "milk-glass", title: "Milk Glass", durationMs: 52_000, status: "missing" },
      next: null,
    };
    const request = playRequestFor(airing, {
      id: "milk-glass",
      title: "Milk Glass",
      year: 1999,
      durationMs: 52_000,
      director: "Ivy Quell",
      genres: ["Horror"],
      keywords: [],
      collection: null,
      synopsis: "",
      scenes: [],
      filePath: "/films/Milk.Glass.1999.mkv",
      metadataId: "tmdb-1",
    });
    assert.equal(request.offsetMs, 42_000);
    assert.equal(request.status, "missing");
    assert.equal(request.filePath, "/films/Milk.Glass.1999.mkv");
    assert.equal(streamSessionFor("ch", request, true).mode, "direct");
  });
});
