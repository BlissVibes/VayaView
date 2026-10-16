import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cycleOrder, guideFrom, onNow, seededShuffle } from "./engine.ts";
import type { Channel, Schedulable } from "./types.ts";

const library = new Map<string, Schedulable>([
  ["a", { id: "a", title: "A", durationMs: 100 }],
  ["b", { id: "b", title: "B", durationMs: 50 }],
  ["c", { id: "c", title: "C", durationMs: 25 }],
]);

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "c1",
    number: 4,
    name: "Test",
    callSign: "TEST",
    mode: "loop",
    shuffleSeed: "c1",
    anchorMs: 1_000,
    mediaIds: ["a", "missing-unknown", "b", "c"],
    query: null,
    ...overrides,
  };
}

describe("onNow", () => {
  it("joins mid-program from the anchor", () => {
    const air = onNow(channel(), library, new Set(), 1_000 + 130);
    assert.ok(air);
    assert.equal(air.slot.mediaId, "b");
    assert.equal(air.offsetMs, 30);
    assert.equal(air.remainingMs, 20);
    assert.equal(air.startedAtMs + air.offsetMs, 1_130);
    assert.equal(air.next?.mediaId, "c");
  });

  it("lets a missing file keep its slot", () => {
    const air = onNow(channel(), library, new Set(["a"]), 1_000 + 40);
    assert.ok(air);
    assert.equal(air.slot.mediaId, "a");
    assert.equal(air.slot.status, "missing");
    assert.equal(air.offsetMs, 40);
    assert.equal(air.next?.mediaId, "b");
  });

  it("wraps before the anchor into the previous cycle", () => {
    const air = onNow(channel(), library, new Set(), 1_000 - 10);
    assert.ok(air);
    assert.equal(air.cycleIndex, -1);
    assert.equal(air.slot.mediaId, "c");
    assert.ok(air.offsetMs >= 0);
    assert.ok(air.offsetMs < air.slot.durationMs);
    assert.equal(air.startedAtMs + air.offsetMs, 990);
  });

  it("starts the next film exactly on a boundary", () => {
    const air = onNow(channel(), library, new Set(), 1_000 + 100);
    assert.equal(air?.slot.mediaId, "b");
    assert.equal(air?.offsetMs, 0);
  });

  it("returns null when nothing has a duration", () => {
    assert.equal(onNow(channel({ mediaIds: ["nope"] }), library, new Set(), 5_000), null);
  });
});

describe("shuffle", () => {
  it("is a stable permutation per cycle", () => {
    const items = ["a", "b", "c", "d"];
    const once = seededShuffle(items, "station:0");
    const twice = seededShuffle(items, "station:0");
    assert.deepEqual(once, twice);
    assert.deepEqual(once.slice().sort(), items.slice().sort());
    const ch = channel({ mode: "shuffle", mediaIds: ["a", "b", "c"], shuffleSeed: "station" });
    const slots = [
      { mediaId: "a", title: "A", durationMs: 100, status: "ready" as const },
      { mediaId: "b", title: "B", durationMs: 50, status: "ready" as const },
      { mediaId: "c", title: "C", durationMs: 25, status: "ready" as const },
    ];
    assert.deepEqual(cycleOrder(slots, ch, 0), cycleOrder(slots, ch, 0));
    const orders = [0, 1, 2, 3, 4].map((cycle) => cycleOrder(slots, ch, cycle).map((slot) => slot.mediaId).join(","));
    assert.ok(new Set(orders).size > 1);
  });
});

describe("guideFrom", () => {
  it("covers the horizon with contiguous slots and keeps the current head", () => {
    const now = 1_000 + 40;
    const guide = guideFrom(channel(), library, new Set(["a"]), now, 200);
    assert.ok(guide.length >= 2);
    assert.equal(guide[0]?.slot.mediaId, "a");
    assert.equal(guide[0]?.slot.status, "missing");
    assert.ok((guide[0]?.startsAtMs ?? 0) <= now);
    for (let i = 1; i < guide.length; i++) {
      assert.equal(guide[i - 1]?.endsAtMs, guide[i]?.startsAtMs);
    }
    const last = guide[guide.length - 1];
    assert.ok(last && last.endsAtMs > now + 200 - 25);
  });
});
