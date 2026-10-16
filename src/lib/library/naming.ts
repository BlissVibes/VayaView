import type { Channel } from "../schedule/types.ts";

export function titleCase(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

export function makeCallSign(name: string, taken: readonly string[]): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  const base = (letters.slice(0, 4) || "STN").padEnd(4, "X");
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 3)}${i % 10}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return base;
}

export function nextNumber(channels: readonly Channel[]): number {
  const used = new Set(channels.map((channel) => channel.number));
  let n = 2;
  while (used.has(n)) n += 1;
  return n;
}
