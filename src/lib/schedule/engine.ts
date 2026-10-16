import type {
  Airing,
  Channel,
  GuideSlot,
  Schedulable,
  Slot,
} from "./types.ts";

/**
 * Wall-clock schedule. No DOM, no player, no clock of its own.
 * Pass `nowMs` in. What's on is fully determined by the lineup and the anchor.
 *
 * A missing file still occupies its duration. Skipping it would desync the
 * station from the clock. Unknown duration (or an unknown id) is left out,
 * because there is no slot to hold.
 */

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const next = mulberry32(hashSeed(seed));
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = swap;
  }
  return copy;
}

export function lineupSlots(
  channel: Channel,
  library: ReadonlyMap<string, Schedulable>,
  missing: ReadonlySet<string>,
): Slot[] {
  const slots: Slot[] = [];
  for (const id of channel.mediaIds) {
    const item = library.get(id);
    if (!item || item.durationMs <= 0) continue;
    slots.push({
      mediaId: item.id,
      title: item.title,
      durationMs: item.durationMs,
      status: missing.has(item.id) ? "missing" : "ready",
    });
  }
  return slots;
}

export function totalDuration(slots: readonly Slot[]): number {
  let total = 0;
  for (const slot of slots) total += slot.durationMs;
  return total;
}

/** Loop keeps marathon order. Shuffle is stable for a given cycle index. */
export function cycleOrder(slots: readonly Slot[], channel: Channel, cycleIndex: number): Slot[] {
  if (channel.mode === "loop") return slots.slice();
  return seededShuffle(slots, `${channel.shuffleSeed}:${cycleIndex}`);
}

export function onNow(
  channel: Channel,
  library: ReadonlyMap<string, Schedulable>,
  missing: ReadonlySet<string>,
  nowMs: number,
): Airing | null {
  const slots = lineupSlots(channel, library, missing);
  const total = totalDuration(slots);
  if (total <= 0 || !Number.isFinite(nowMs)) return null;

  const elapsed = nowMs - channel.anchorMs;
  const cycleIndex = Math.floor(elapsed / total);
  const within = elapsed - cycleIndex * total;
  const order = cycleOrder(slots, channel, cycleIndex);

  let cursor = 0;
  for (let i = 0; i < order.length; i++) {
    const slot = order[i] as Slot;
    const end = cursor + slot.durationMs;
    if (within < end) {
      const offsetMs = within - cursor;
      const startedAtMs = nowMs - offsetMs;
      const next = nextSlot(slots, channel, cycleIndex, order, i);
      return {
        channelId: channel.id,
        cycleIndex,
        slotIndex: i,
        offsetMs,
        remainingMs: slot.durationMs - offsetMs,
        startedAtMs,
        endsAtMs: startedAtMs + slot.durationMs,
        slot,
        next,
      };
    }
    cursor = end;
  }
  return null;
}

function nextSlot(
  slots: readonly Slot[],
  channel: Channel,
  cycleIndex: number,
  order: readonly Slot[],
  slotIndex: number,
): Slot | null {
  if (order.length === 0) return null;
  if (slotIndex + 1 < order.length) return order[slotIndex + 1] ?? null;
  const following = cycleOrder(slots, channel, cycleIndex + 1);
  return following[0] ?? null;
}

/** Guide from `nowMs` forward. The first block may have started already. */
export function guideFrom(
  channel: Channel,
  library: ReadonlyMap<string, Schedulable>,
  missing: ReadonlySet<string>,
  nowMs: number,
  horizonMs: number,
): GuideSlot[] {
  const airing = onNow(channel, library, missing, nowMs);
  if (!airing || horizonMs < 0) return [];

  const slots = lineupSlots(channel, library, missing);
  const out: GuideSlot[] = [];
  let cycle = airing.cycleIndex;
  let order = cycleOrder(slots, channel, cycle);
  let index = airing.slotIndex;
  let cursor = airing.startedAtMs;
  const end = nowMs + horizonMs;

  while (cursor < end && out.length < 64) {
    const slot = order[index];
    if (!slot) break;
    const slotEnd = cursor + slot.durationMs;
    out.push({ startsAtMs: cursor, endsAtMs: slotEnd, slot });
    cursor = slotEnd;
    index += 1;
    if (index >= order.length) {
      index = 0;
      cycle += 1;
      order = cycleOrder(slots, channel, cycle);
    }
  }
  return out;
}
