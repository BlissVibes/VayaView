import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CATALOG, catalogById, diskMissingIds, libraryInfo } from "@/lib/library/catalog";
import { loadDiskLibrary } from "@/lib/library/disk";
import { createFactoryState, refreshDiskState } from "@/lib/library/factory";
import { parlorReducer, type ParlorAction } from "@/lib/library/reducer";
import type { ParlorState } from "@/lib/library/state";
import { loadPersisted, savePersisted } from "@/lib/library/storage";
import { playRequestFor, type PlayRequest } from "@/lib/player/seam";
import { onNow } from "@/lib/schedule/engine";
import type { Airing, Channel, Schedulable } from "@/lib/schedule/types";
import type { Film } from "@/lib/library/types";
import { durable } from "@/lib/durable";

export type Overlay = "none" | "guide" | "lineup";

/** What the schedule can place. Refilled in place after a rescan, so every reader sees the new library. */
export const scheduleLibrary = new Map<string, Schedulable>();

function fillSchedule() {
  scheduleLibrary.clear();
  for (const film of CATALOG) scheduleLibrary.set(film.id, { id: film.id, title: film.title, durationMs: film.durationMs });
}
fillSchedule();

export type RescanResult = { added: number; removed: number; error: string | null };

/** The stations as they were just before one edit. */
export type Snapshot = { label: string; channels: Channel[]; hiddenIds?: string[]; at: number };

const HISTORY_LIMIT = 25;
const EDITS = new Set<ParlorAction["type"]>([
  "create", "create-many", "delete", "mode", "rename", "callsign", "number", "swap-number", "reorder", "shift", "restart", "remove-media", "set-media", "favorite", "color", "toggle-missing", "reset",
]);

/** One undo list per library, beside that library's saved stations. */
function historyKey(): string {
  return `parlor.history:${libraryInfo.folders.join("|")}`;
}

function loadHistory(): Snapshot[] {
  try {
    const list = JSON.parse(durable.getItem(historyKey()) ?? "[]") as Snapshot[];
    return Array.isArray(list) ? list.filter((item) => Array.isArray(item?.channels)) : [];
  } catch {
    return [];
  }
}

function saveHistory(list: Snapshot[]) {
  // Lineups can be long. If storage runs short, keep fewer steps rather than none.
  for (const size of [list.length, 10, 3]) {
    try {
      durable.setItem(historyKey(), JSON.stringify(list.slice(0, size)));
      return;
    } catch {
      // try a shorter list
    }
  }
}

/** A short sentence for the undo button. */
function describe(action: ParlorAction, state: ParlorState): string {
  const name = (id: string) => state.channels.find((channel) => channel.id === id)?.name ?? "a station";
  switch (action.type) {
    case "create":
      return `Made ${action.name}`;
    case "create-many":
      return action.items.length === 1 ? `Made ${action.items[0]?.name}` : `Made ${action.items.length} stations`;
    case "delete":
      return `Removed ${name(action.id)}`;
    case "rename":
      return `Renamed ${name(action.id)}`;
    case "number":
      return `Renumbered ${name(action.id)}`;
    case "swap-number": {
      const other = state.channels.find((channel) => channel.id !== action.id && channel.number === action.number);
      return other ? `Swapped ${name(action.id)} and ${other.name}` : `Renumbered ${name(action.id)}`;
    }
    case "reorder":
      return action.label;
    case "shift":
      return `Moved ${name(action.id)} ${Math.abs(action.byMs) / 60000} min ${action.byMs > 0 ? "later" : "earlier"}`;
    case "restart":
      return `Started ${name(action.id)} from the top`;
    case "callsign":
      return `Changed call sign of ${name(action.id)}`;
    case "mode":
      return `Changed order of ${name(action.id)}`;
    case "remove-media":
      return `Dropped ${catalogById.get(action.mediaId)?.title ?? "an item"} from ${name(action.id)}`;
    case "set-media":
      return action.label;
    case "favorite":
      return `${state.channels.find((channel) => channel.id === action.id)?.favorite ? "Unfavorited" : "Favorited"} ${name(action.id)}`;
    case "color":
      return `Recolored ${name(action.id)}`;
    default:
      return "Changed stations";
  }
}

export function useParlor() {
  const [state, dispatch] = useReducer(parlorReducer, undefined, createFactoryState);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [digits, setDigits] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>("guide");
  const [libraryVersion, setLibraryVersion] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Read the folders again with the app open. Stations pick up new files; what is playing keeps playing. */
  const rescan = useCallback(async (): Promise<RescanResult> => {
    const before = new Set(CATALOG.map((film) => film.id));
    await loadDiskLibrary(true);
    if (libraryInfo.error) return { added: 0, removed: 0, error: libraryInfo.error };
    fillSchedule();
    const after = new Set(CATALOG.map((film) => film.id));
    dispatch({ type: "replace", state: refreshDiskState(stateRef.current) });
    setLibraryVersion((value) => value + 1);
    return {
      added: [...after].filter((id) => !before.has(id)).length,
      removed: [...before].filter((id) => !after.has(id)).length,
      error: null,
    };
  }, []);

  const commitDigits = useCallback(
    (value: string) => {
      if (!value) return;
      const found = state.channels.find((channel) => channel.number === Number(value));
      if (found) dispatch({ type: "tune", id: found.id });
      else setNotice(`No station ${value}`);
      setDigits("");
    },
    [state.channels],
  );

  useEffect(() => {
    const saved = loadPersisted();
    if (saved) dispatch({ type: "replace", state: refreshDiskState(saved) });
    setReady(true);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Undo. Each station edit keeps a copy of the stations from just before it, newest first, on disk,
  // so a slip can be taken back even after a restart. Tuning and power are not edits.
  const [history, setHistory] = useState<Snapshot[]>(loadHistory);
  const pendingNote = useRef<string | null>(null);

  function remember(label: string, before: ParlorState) {
    setHistory((list) => {
      const next = [{ label, channels: before.channels, hiddenIds: before.hiddenIds, at: Date.now() }, ...list].slice(0, HISTORY_LIMIT);
      saveHistory(next);
      return next;
    });
  }

  const edit = useCallback((action: ParlorAction) => {
    if (!EDITS.has(action.type)) return dispatch(action);
    const before = stateRef.current;
    const after = parlorReducer(before, action);
    // A field left without a change is not an edit, and does not crowd the undo list.
    if (JSON.stringify(after.channels) === JSON.stringify(before.channels) && after.hiddenIds === before.hiddenIds) return;
    remember(describe(action, before), before);
    dispatch(action);
  }, []);

  /** Put a whole set of stations in place (undo, or a loaded backup). The set it replaces can itself be undone. */
  function apply(channels: Channel[], hiddenIds: string[] | undefined, note: string) {
    const current = stateRef.current;
    const has = (id: string | null) => id != null && channels.some((channel) => channel.id === id);
    pendingNote.current = note;
    dispatch({
      type: "replace",
      state: {
        ...current,
        channels,
        hiddenIds,
        tunedId: has(current.tunedId) ? current.tunedId : (channels[0]?.id ?? current.tunedId),
        lastId: has(current.lastId) ? current.lastId : null,
      },
    });
  }

  const undo = useCallback(() => {
    setHistory((list) => {
      const [last, ...rest] = list;
      if (!last) return list;
      saveHistory(rest);
      apply(last.channels, last.hiddenIds, `Undid: ${last.label}`);
      return rest;
    });
  }, []);

  function restore(channels: Channel[], hiddenIds: string[] | undefined, label: string) {
    remember(`Before ${label.toLowerCase()}`, stateRef.current);
    apply(channels, hiddenIds, label);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  // Every change is written at once. `saved` is the receipt shown on screen after a station edit.
  const [saved, setSaved] = useState<string | null>(null);
  const savedChannels = useRef<Channel[] | null>(null);
  useEffect(() => {
    if (!ready) return;
    let ok = true;
    try {
      savePersisted(state);
    } catch {
      ok = false;
    }
    if (!ok) setSaved("Could not save. Changes will be lost when VayaView closes.");
    else if (savedChannels.current && savedChannels.current !== state.channels) {
      setSaved(pendingNote.current ?? "Saved");
      pendingNote.current = null;
    }
    savedChannels.current = state.channels;
  }, [ready, state]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), 2200);
    return () => window.clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (!digits) return;
    const timer = window.setTimeout(() => commitDigits(digits), digits.length >= 3 ? 0 : 900);
    return () => window.clearTimeout(timer);
  }, [commitDigits, digits]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        setOverlay((value) => (value === "guide" ? "none" : "guide"));
        setDigits("");
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        dispatch({ type: "step", dir: 1 });
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        dispatch({ type: "step", dir: -1 });
        return;
      }
      if (event.key === "g" || event.key === "G") {
        setOverlay((value) => (value === "guide" ? "none" : "guide"));
        return;
      }
      if (event.key === "l" || event.key === "L") {
        setOverlay((value) => (value === "lineup" ? "guide" : "lineup"));
        return;
      }
      if (event.key === "p" || event.key === "P") {
        dispatch({ type: "power" });
        return;
      }
      if (event.key === "Enter") {
        commitDigits(digits);
        return;
      }
      if (event.key === "Backspace") {
        if (digits) setDigits((value) => value.slice(0, -1));
        else if (state.lastId) dispatch({ type: "tune", id: state.lastId });
        return;
      }
      if (/^[0-9]$/.test(event.key)) setDigits((value) => (value + event.key).slice(0, 3));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitDigits, digits, state.lastId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- diskMissingIds changes in place on a rescan; libraryVersion marks it.
  const missing = useMemo(() => new Set([...state.missingIds, ...diskMissingIds]), [state.missingIds, libraryVersion]);
  const channel = state.channels.find((item) => item.id === state.tunedId) ?? state.channels[0] ?? null;
  const airing = channel && now != null ? onNow(channel, scheduleLibrary, missing, now) : null;
  const film = airing ? (catalogById.get(airing.slot.mediaId) ?? null) : null;
  const request = airing ? playRequestFor(airing, film) : null;

  return {
    state,
    /** Station edits go through the undo list. Everything else goes straight to the reducer. */
    dispatch: edit as (action: ParlorAction) => void,
    history,
    undo,
    restore,
    now,
    digits,
    notice,
    saved,
    rescan,
    libraryVersion,
    overlay,
    setOverlay,
    channel,
    airing,
    film,
    request,
    missing,
    pushDigit(digit: string) {
      setDigits((value) => (value + digit).slice(0, 3));
    },
    commitDigits,
    tune(id: string) {
      dispatch({ type: "tune", id });
      setOverlay("none");
    },
  };
}

export type ParlorView = {
  state: ParlorState;
  now: number | null;
  digits: string;
  notice: string | null;
  overlay: Overlay;
  channel: Channel | null;
  airing: Airing | null;
  film: Film | null;
  request: PlayRequest | null;
};
