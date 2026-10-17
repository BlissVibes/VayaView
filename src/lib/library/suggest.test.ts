import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG } from "./catalog.ts";
import { suggestStations } from "./suggest.ts";
import { parlorReducer } from "./reducer.ts";
import { createFactoryState } from "./factory.ts";
import type { Film } from "./types.ts";
import type { Channel } from "../schedule/types.ts";

const film = (id: string, extra: Partial<Film>): Film => ({
  id,
  title: id,
  year: 2000,
  durationMs: 60_000,
  director: "",
  genres: ["Movie"],
  keywords: [],
  collection: null,
  synopsis: "",
  scenes: [],
  filePath: `/x/${id}.mkv`,
  metadataId: null,
  ...extra,
});

const channel = (id: string, name: string, mediaIds: string[]): Channel => ({ id, number: 2, name, callSign: "XXXX", mode: "shuffle", shuffleSeed: id, anchorMs: 0, mediaIds, query: null });

describe("suggestStations", () => {
  const library: Film[] = [
    ...Array.from({ length: 6 }, (_, i) => film(`h${i}`, { genres: ["Movie", "Horror"], year: 1980 + i, director: "Ned Carrow", keywords: ["slasher"] })),
    ...Array.from({ length: 3 }, (_, i) => film(`t${i}`, { genres: ["Movie", "Action"], year: 2007 + i * 2, collection: "Iron Harvest Collection" })),
    ...Array.from({ length: 8 }, (_, i) => film(`a${i}`, { genres: ["TV", "Comedy"], collection: "Office Hours", season: 1, episode: i + 1 })),
    ...Array.from({ length: 8 }, (_, i) => film(`b${i}`, { genres: ["TV", "Comedy"], collection: "Night Desk", season: 1, episode: i + 1 })),
    film("solo", { genres: ["Movie", "Western"] }),
  ];

  it("offers movies, tv, shows, a franchise in order, a genre, a decade, a director and a theme", () => {
    const got = suggestStations(library, []);
    const byName = new Map(got.map((item) => [item.name, item]));
    assert.ok(byName.has("Movies"));
    assert.ok(byName.has("TV Mix"));
    assert.equal(byName.get("Office Hours")?.mode, "loop");
    assert.equal(byName.get("Night Desk")?.mediaIds.length, 8);
    assert.deepEqual(byName.get("Iron Harvest")?.mediaIds, ["t0", "t1", "t2"]);
    assert.equal(byName.get("Iron Harvest")?.mode, "loop");
    assert.ok(byName.has("Horror Movies"));
    assert.ok(byName.has("Comedy TV"));
    assert.ok(byName.has("1980s Movies"));
    assert.ok(byName.has("Ned Carrow"));
    assert.ok(byName.has("Slasher"));
    // One western is not a station.
    assert.ok(!byName.has("Western Movies"));
  });

  it("leaves out a station already in the lineup, by lineup or by name", () => {
    const horror = library.filter((item) => item.genres.includes("Horror")).map((item) => item.id);
    const got = suggestStations(library, [channel("c1", "Scary Stuff", horror), channel("c2", "Office Hours", ["a0"])]);
    const names = got.map((item) => item.name);
    assert.ok(!names.includes("Horror Movies"));
    assert.ok(!names.includes("Office Hours"));
    assert.ok(names.includes("Night Desk"));
  });

  it("skips TV genres that are really one show", () => {
    const one = library.filter((item) => item.collection !== "Night Desk");
    const got = suggestStations(one, []);
    assert.ok(!got.some((item) => item.name === "Comedy TV"));
  });

  it("works on the preview catalogue without throwing", () => {
    const got = suggestStations(CATALOG, []);
    assert.ok(Array.isArray(got));
  });

  it("create-many adds every station in one step and keeps the set where it was", () => {
    const start = createFactoryState();
    const items = suggestStations(CATALOG, start.channels).slice(0, 3).map((item, i) => ({ id: `new-${i}`, name: item.name, mediaIds: item.mediaIds, mode: item.mode }));
    const next = parlorReducer(start, { type: "create-many", items, now: 1 });
    assert.equal(next.channels.length, start.channels.length + items.length);
    assert.equal(next.tunedId, start.tunedId);
    assert.equal(new Set(next.channels.map((channel) => channel.number)).size, next.channels.length);
  });
});
