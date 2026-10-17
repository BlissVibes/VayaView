import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { surfOffset } from "./surf.ts";

/** A fixed sequence standing in for Math.random. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe("surfOffset", () => {
  const hour = 60 * 60_000;

  it("leaves a clock station on its clock", () => {
    assert.equal(surfOffset(hour, "clock", null), null);
    assert.equal(surfOffset(hour, undefined, null), null);
  });

  it("lands a start station within the first tenth", () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const at = surfOffset(hour, "start", null, () => r);
      assert.ok(at != null && at >= 0 && at <= 0.1 * hour, `${r} → ${at}`);
    }
  });

  it("lands 15 to 30 s before one of the top three peaks", () => {
    const peaks = [
      { t: 100, v: 0.2 },
      { t: 900, v: 1 },
      { t: 1500, v: 0.6 },
      { t: 2400, v: 0.5 },
      { t: 3000, v: 0.1 },
    ];
    const top = [900, 1500, 2400];
    for (const pick of [0, 0.4, 0.99]) {
      for (const lead of [0, 0.5, 0.999]) {
        const at = surfOffset(hour, "peaks", peaks, sequence(pick, lead));
        assert.ok(at != null);
        const peak = top.find((t) => t * 1000 - at >= 15_000 && t * 1000 - at <= 30_000);
        assert.ok(peak != null, `pick ${pick} lead ${lead} → ${at}`);
      }
    }
  });

  it("never lands before 0 for an early peak", () => {
    const at = surfOffset(hour, "peaks", [{ t: 8, v: 1 }], sequence(0, 0.9));
    assert.equal(at, 0);
  });

  it("falls back to the first tenth when there are no peaks", () => {
    for (const peaks of [null, []]) {
      const at = surfOffset(hour, "peaks", peaks, () => 0.5);
      assert.equal(at, 0.05 * hour);
    }
  });

  it("never lands in the last five seconds", () => {
    const at = surfOffset(20_000, "start", null, () => 0.999);
    assert.ok(at != null && at <= 15_000);
    assert.equal(surfOffset(60_000, "peaks", [{ t: 59, v: 1 }], () => 0.5), 3000);
  });
});
