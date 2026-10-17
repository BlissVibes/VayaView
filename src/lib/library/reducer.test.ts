import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFactoryState } from "./factory.ts";
import { parlorReducer } from "./reducer.ts";

describe("parlorReducer", () => {
  it("refuses to delete the last channel", () => {
    const start = createFactoryState();
    let state = start;
    for (const channel of start.channels) {
      state = parlorReducer(state, { type: "delete", id: channel.id });
    }
    assert.equal(state.channels.length, 1);
  });

  it("tunes a new channel and will not take a duplicate number", () => {
    const start = createFactoryState();
    const next = parlorReducer(start, {
      type: "create",
      id: "ch-new",
      name: "Night Desk",
      query: "sci-fi",
      mediaIds: ["orbit-desk"],
      mode: "loop",
      now: 50_000,
    });
    assert.equal(next.tunedId, "ch-new");
    assert.equal(next.lastId, "ch-iron");
    const created = next.channels.find((channel) => channel.id === "ch-new");
    assert.ok(created);
    assert.equal(created.anchorMs, 50_000);
    const clash = parlorReducer(next, { type: "number", id: "ch-new", number: 4 });
    assert.equal(clash.channels.find((channel) => channel.id === "ch-new")?.number, created.number);
  });

  it("marks a file missing without removing it from the lineup", () => {
    const start = createFactoryState();
    const hidden = parlorReducer(start, { type: "toggle-missing", mediaId: "lantern-night" });
    assert.ok(hidden.missingIds.includes("lantern-night"));
    const dark = hidden.channels.find((channel) => channel.id === "ch-dark");
    assert.ok(dark?.mediaIds.includes("lantern-night"));
  });

  it("sets how a station tunes in, as an edit that keeps everything else", () => {
    const start = createFactoryState();
    const next = parlorReducer(start, { type: "surf", id: "ch-dark", surf: "peaks" });
    const dark = next.channels.find((channel) => channel.id === "ch-dark");
    assert.equal(dark?.surf, "peaks");
    assert.deepEqual({ ...dark, surf: undefined }, { ...start.channels.find((channel) => channel.id === "ch-dark"), surf: undefined });
    assert.equal(next.tunedId, start.tunedId);
  });

  it("makes children of a station with create-many, keeping parent, surf and source", () => {
    const start = createFactoryState();
    const youtube = { channel: "Jerma985", channelUrl: "https://www.youtube.com/@Jerma985", kind: "uploads", url: "https://www.youtube.com/@Jerma985/videos" };
    const next = parlorReducer(start, {
      type: "create-many",
      now: 9_000,
      items: [
        { id: "kid-1", name: "First video", mediaIds: ["yt-aaaaaaaaaaa"], mode: "loop", surf: "start", parentId: "ch-far", youtube },
        { id: "kid-2", name: "Second video", mediaIds: ["yt-bbbbbbbbbbb"], mode: "loop", surf: "start", parentId: "ch-far", youtube },
      ],
    });
    assert.equal(next.tunedId, start.tunedId);
    const kids = next.channels.filter((channel) => channel.parentId === "ch-far");
    assert.equal(kids.length, 2);
    assert.deepEqual(kids.map((kid) => kid.surf), ["start", "start"]);
    assert.deepEqual(kids[0]?.youtube, youtube);
    // The next free numbers, not ones already in use.
    const used = start.channels.map((channel) => channel.number);
    assert.ok(kids.every((kid) => !used.includes(kid.number)));
    assert.notEqual(kids[0]?.number, kids[1]?.number);
    // An ordinary station made the same way carries none of the new fields.
    const plain = parlorReducer(start, { type: "create-many", now: 1, items: [{ id: "plain", name: "Plain", mediaIds: ["orbit-desk"], mode: "loop" }] });
    const made = plain.channels.find((channel) => channel.id === "plain");
    assert.ok(made && !("surf" in made) && !("parentId" in made) && !("youtube" in made));
  });

  it("deletes several stations at once, moving the set off a deleted one", () => {
    const start = { ...createFactoryState(), tunedId: "ch-dark", lastId: "ch-grow" };
    const next = parlorReducer(start, { type: "delete-many", ids: ["ch-dark", "ch-grow"] });
    assert.deepEqual(next.channels.map((channel) => channel.id), ["ch-iron", "ch-voss", "ch-far"]);
    assert.equal(next.tunedId, "ch-iron");
    assert.equal(next.lastId, null);
  });

  it("keeps one station when delete-many is asked to remove them all", () => {
    const start = createFactoryState();
    const next = parlorReducer(start, { type: "delete-many", ids: start.channels.map((channel) => channel.id) });
    assert.equal(next.channels.length, 1);
    assert.equal(next.channels[0]?.id, "ch-iron");
    assert.equal(next.tunedId, "ch-iron");
  });

  it("survives a save and load with its YouTube fields", async () => {
    const { sanitizeState } = await import("./storage.ts");
    const start = createFactoryState();
    const youtube = { channel: "C", channelUrl: "u", kind: "uploads", url: "u/videos" };
    const next = parlorReducer(start, { type: "create-many", now: 1, items: [{ id: "kid", name: "Kid", mediaIds: ["yt-ccccccccccc"], mode: "loop", surf: "peaks", parentId: "ch-iron", youtube }] });
    const loaded = sanitizeState(JSON.parse(JSON.stringify(next)));
    const kid = loaded?.channels.find((channel) => channel.id === "kid");
    assert.deepEqual({ surf: kid?.surf, parentId: kid?.parentId, youtube: kid?.youtube }, { surf: "peaks", parentId: "ch-iron", youtube });
  });
});
