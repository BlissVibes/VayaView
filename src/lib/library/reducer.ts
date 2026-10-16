import type { ChannelMode } from "../schedule/types.ts";
import { createFactoryState } from "./factory.ts";
import { makeCallSign, nextNumber } from "./naming.ts";
import type { ParlorState } from "./state.ts";

export type ParlorAction =
  | { type: "replace"; state: ParlorState }
  | { type: "tune"; id: string }
  | { type: "step"; dir: 1 | -1 }
  | { type: "power" }
  | {
      type: "create";
      id: string;
      name: string;
      query: string;
      mediaIds: string[];
      mode: ChannelMode;
      now: number;
    }
  | { type: "delete"; id: string }
  | { type: "mode"; id: string; mode: ChannelMode; now: number }
  | { type: "rename"; id: string; name: string }
  | { type: "callsign"; id: string; callSign: string }
  | { type: "number"; id: string; number: number }
  | { type: "remove-media"; id: string; mediaId: string; now: number }
  | { type: "toggle-missing"; mediaId: string }
  | { type: "favorite"; id: string }
  /** Move a station's whole schedule later (positive) or earlier (negative), or start it from the top now. */
  | { type: "shift"; id: string; byMs: number }
  | { type: "restart"; id: string; now: number }
  /** Take a number that may be in use. The station holding it gets this one
  /** Replace a station's whole lineup, for adding things back. `label` names the edit for undo. */
  | { type: "set-media"; id: string; mediaIds: string[]; now: number; label: string }
  | { type: "color"; id: string; color: string | null }
  | { type: "reset" };

function tune(state: ParlorState, id: string): ParlorState {
  if (id === state.tunedId) return state;
  if (!state.channels.some((channel) => channel.id === id)) return state;
  return { ...state, tunedId: id, lastId: state.tunedId };
}

function ordered(state: ParlorState) {
  return state.channels.slice().sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
}

export function parlorReducer(state: ParlorState, action: ParlorAction): ParlorState {
  switch (action.type) {
    case "replace":
      return action.state.channels.length > 0 ? action.state : state;
    case "tune":
      return tune(state, action.id);
    case "step": {
      const list = ordered(state);
      if (list.length === 0) return state;
      const index = list.findIndex((channel) => channel.id === state.tunedId);
      const next = list[(index + action.dir + list.length) % list.length];
      return next ? tune(state, next.id) : state;
    }
    case "power":
      return { ...state, powered: !state.powered };
    case "create": {
      if (action.mediaIds.length === 0 || !action.name.trim()) return state;
      const channel = {
        id: action.id,
        number: nextNumber(state.channels),
        name: action.name.trim(),
        callSign: makeCallSign(action.name, state.channels.map((item) => item.callSign)),
        mode: action.mode,
        shuffleSeed: action.id,
        anchorMs: action.now,
        mediaIds: action.mediaIds,
        query: action.query,
      };
      return tune({ ...state, channels: [...state.channels, channel] }, channel.id);
    }
    case "delete": {
      if (state.channels.length <= 1) return state;
      const channels = state.channels.filter((channel) => channel.id !== action.id);
      const tunedId = state.tunedId === action.id ? (channels[0]?.id ?? state.tunedId) : state.tunedId;
      const lastId = state.lastId === action.id ? null : state.lastId;
      const next = { ...state, channels, tunedId, lastId };
      // A built-in station would come back on the next scan. Remember that it was removed.
      return action.id.startsWith("ch-auto-") ? { ...next, hiddenIds: [...(state.hiddenIds ?? []), action.id] } : next;
    }
    case "mode":
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === action.id ? { ...channel, mode: action.mode, anchorMs: action.now } : channel,
        ),
      };
    case "rename": {
      const name = action.name.trim();
      if (!name) return state;
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === action.id ? { ...channel, name } : channel,
        ),
      };
    }
    case "callsign": {
      const callSign = action.callSign.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4);
      if (callSign.length < 2) return state;
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === action.id ? { ...channel, callSign } : channel,
        ),
      };
    }
    case "number": {
      if (!Number.isInteger(action.number) || action.number < 1 || action.number > 999) return state;
      if (state.channels.some((channel) => channel.id !== action.id && channel.number === action.number)) {
        return state;
      }
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === action.id ? { ...channel, number: action.number } : channel,
        ),
      };
    }
    case "remove-media":
      return {
        ...state,
        channels: state.channels.map((channel) => {
          if (channel.id !== action.id) return channel;
          if (channel.mediaIds.length <= 1) return channel;
          return {
            ...channel,
            mediaIds: channel.mediaIds.filter((id) => id !== action.mediaId),
            anchorMs: action.now,
            // A hand-trimmed built-in station keeps its lineup instead of being refilled from disk.
            ...(channel.id.startsWith("ch-auto-") ? { edited: true } : {}),
          };
        }),
      };
    case "toggle-missing": {
      const missingIds = state.missingIds.includes(action.mediaId)
        ? state.missingIds.filter((id) => id !== action.mediaId)
        : [...state.missingIds, action.mediaId];
      return { ...state, missingIds };
    }
    case "set-media":
      if (action.mediaIds.length === 0) return state;
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === action.id
            ? {
                ...channel,
                mediaIds: [...new Set(action.mediaIds)],
                anchorMs: action.now,
                ...(channel.id.startsWith("ch-auto-") ? { edited: true } : {}),
              }
            : channel,
        ),
      };
    case "swap-number": {
      const me = state.channels.find((channel) => channel.id === action.id);
      if (!me || !Number.isInteger(action.number) || action.number < 1 || action.number > 999) return state;
      const other = state.channels.find((channel) => channel.id !== action.id && channel.number === action.number);
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === me.id ? { ...channel, number: action.number } : channel.id === other?.id ? { ...channel, number: me.number } : channel,
        ),
      };
    }
    case "reorder": {
      const rank = new Map(action.ids.map((id, i) => [id, i]));
      if (rank.size !== state.channels.length || state.channels.some((channel) => !rank.has(channel.id))) return state;
      const numbers = state.channels.map((channel) => channel.number).sort((a, b) => a - b);
      return {
        ...state,
        channels: state.channels.map((channel) => ({ ...channel, number: numbers[rank.get(channel.id) ?? 0] ?? channel.number })),
      };
    }
    case "shift":
      return {
        ...state,
        channels: state.channels.map((channel) => (channel.id === action.id ? { ...channel, anchorMs: channel.anchorMs + action.byMs } : channel)),
      };
    case "restart":
      return {
        ...state,
        channels: state.channels.map((channel) => (channel.id === action.id ? { ...channel, anchorMs: action.now } : channel)),
      };
    case "favorite":
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === action.id ? { ...channel, favorite: !channel.favorite } : channel,
        ),
      };
    case "color":
      return {
        ...state,
        channels: state.channels.map((channel) =>
          channel.id === action.id ? { ...channel, color: action.color ?? undefined } : channel,
        ),
      };
    case "reset":
      return createFactoryState();
    default:
      return state;
  }
}
