import type { Channel } from "../schedule/types.ts";
import type { ParlorState } from "./state.ts";
import { STORAGE_KEY } from "./state.ts";
import { isDiskLibrary, libraryInfo } from "./catalog.ts";
import { durable } from "../durable.ts";

/** The demo stations and the user's own stations never share a save. */
function storageKey(): string {
  return isDiskLibrary() ? `${STORAGE_KEY}.disk:${libraryInfo.folders.join("|")}` : STORAGE_KEY;
}

function isChannel(value: unknown): value is Channel {
  if (!value || typeof value !== "object") return false;
  const channel = value as Channel;
  return (
    typeof channel.id === "string" &&
    typeof channel.number === "number" &&
    typeof channel.name === "string" &&
    typeof channel.callSign === "string" &&
    (channel.mode === "loop" || channel.mode === "shuffle") &&
    typeof channel.shuffleSeed === "string" &&
    typeof channel.anchorMs === "number" &&
    Array.isArray(channel.mediaIds) &&
    (typeof channel.query === "string" || channel.query === null)
  );
}

export function sanitizeState(value: unknown): ParlorState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as ParlorState;
  if (!Array.isArray(state.channels) || state.channels.length === 0) return null;
  if (!state.channels.every(isChannel)) return null;
  if (!Array.isArray(state.missingIds) || !state.missingIds.every((id) => typeof id === "string")) return null;
  if (typeof state.powered !== "boolean") return null;
  const tunedId = state.channels.some((channel) => channel.id === state.tunedId)
    ? state.tunedId
    : state.channels[0]?.id;
  if (!tunedId) return null;
  const lastId =
    typeof state.lastId === "string" && state.channels.some((channel) => channel.id === state.lastId)
      ? state.lastId
      : null;
  return { ...state, tunedId, lastId };
}

export function loadPersisted(): ParlorState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = durable.getItem(storageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number; state?: unknown };
    if (parsed.version !== 1) return null;
    return sanitizeState(parsed.state);
  } catch {
    return null;
  }
}

export function savePersisted(state: ParlorState): void {
  if (typeof localStorage === "undefined") return;
  durable.setItem(storageKey(), JSON.stringify({ version: 1, state }));
}
