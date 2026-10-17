import { durable } from "./durable.ts";

/**
 * What happens to a station while the viewer is on another one (Settings › Surfing).
 * "continuous": it keeps running, like broadcast; coming back joins the clock. The default.
 * "youtube": YouTube stations wait where they were left, for up to six hours. Others run on.
 * "all": every station waits.
 */
export type FlipPause = "continuous" | "youtube" | "all";

const KEY = "parlor.flipPause";

export function loadFlipPause(): FlipPause {
  const saved = durable.getItem(KEY);
  return saved === "youtube" || saved === "all" ? saved : "continuous";
}

export function saveFlipPause(value: FlipPause): void {
  durable.setItem(KEY, value);
}
