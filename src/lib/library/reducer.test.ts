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
});
