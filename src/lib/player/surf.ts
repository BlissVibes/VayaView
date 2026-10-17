import type { SurfMode } from "../schedule/types.ts";

/** A moment YouTube viewers replay most: seconds into the video, and how strongly (0 to 1). */
export type Peak = { t: number; v: number };

/** How many of the strongest peaks a landing picks from, so the same video does not always open on the same moment. */
const TOP_PEAKS = 3;
/** A peak is joined this long before it (15 to 30 seconds), so the moment builds instead of starting mid-laugh. */
const LEAD_MIN_S = 15;
const LEAD_SPREAD_S = 15;
/** Never land so near the end that the programme is over before it is seen. */
const END_GUARD_MS = 5000;

/**
 * Where a tune-in lands in a programme, in milliseconds, or null to join on the station's clock.
 *
 * - "clock": null. The station's clock decides, as on every broadcast station.
 * - "start": a random point in the first tenth.
 * - "peaks": one of the three strongest peaks, at random, joined 15 to 30 s before it and never
 *   before 0. With no peaks (not a YouTube video, too few views for YouTube to keep a curve, or
 *   the curve not fetched yet) it lands as "start".
 *
 * `random` is Math.random in the app and a fixed sequence in the tests.
 */
export function surfOffset(durationMs: number, mode: SurfMode | undefined, peaks: readonly Peak[] | null, random: () => number = Math.random): number | null {
  if (!mode || mode === "clock" || !(durationMs > 0)) return null;
  const last = Math.max(0, durationMs - END_GUARD_MS);
  if (mode === "peaks" && peaks && peaks.length > 0) {
    const top = peaks
      .filter((peak) => peak.t * 1000 < last)
      .slice()
      .sort((a, b) => b.v - a.v)
      .slice(0, TOP_PEAKS);
    if (top.length > 0) {
      const peak = top[Math.min(top.length - 1, Math.floor(random() * top.length))]!;
      const lead = LEAD_MIN_S + random() * LEAD_SPREAD_S;
      return Math.min(last, Math.max(0, Math.round((peak.t - lead) * 1000)));
    }
  }
  return Math.min(last, Math.round(random() * 0.1 * durationMs));
}
