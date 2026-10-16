import { useEffect, useRef, useState } from "react";
import { CATALOG, catalogById, libraryInfo } from "@/lib/library/catalog";
import { titleCase } from "@/lib/library/naming";
import { sanitizeState } from "@/lib/library/storage";
import type { ParlorAction } from "@/lib/library/reducer";
import type { ParlorState } from "@/lib/library/state";
import type { Film } from "@/lib/library/types";
import type { Channel, ChannelMode } from "@/lib/schedule/types";
import { formatStation } from "@/lib/format";
import { CHANNEL_COLORS } from "@/lib/theme";
import { cn } from "@/lib/cn";
import { ColorInput } from "./color-input";
import { EpisodeCheck } from "./episodes";
import { LibraryPicker } from "./library-picker";
import type { Snapshot } from "./use-parlor";

type LineupProps = {
  state: ParlorState;
  dispatch: (action: ParlorAction) => void;
  onClose: () => void;
  history: Snapshot[];
  onUndo: () => void;
  onRestore: (channels: Channel[], hiddenIds: string[] | undefined, label: string) => void;
  /** Open this station in the editor (from the right-click menu). */
  focusId?: string | null;
  onMenu?: (id: string, x: number, y: number) => void;
  className?: string;
};

type Conflict = { number: number; name: string };

/** The same films or episodes, in any order. */
const lineupKey = (ids: string[]) => ids.slice().sort().join();

const headerButton = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-40";
/** Catalogue order: films by title, shows by season and episode. Added things slot in where they belong. */
const catalogOrder = (ids: string[]) => {
  const order = new Map(CATALOG.map((film, i) => [film.id, i]));
  return ids.slice().sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
};

const fieldClass =
  "mt-1 w-full rounded-lg border border-cream/15 bg-room px-3 py-2 text-sm text-cream outline-none focus-visible:outline-2 focus-visible:outline-accent";
const pill = (on: boolean) => cn("h-9 rounded-full px-3 text-sm", on ? "bg-cream text-room" : "bg-room text-cream hover:bg-cream/10");
/** Long lineups are listed up to here. TV Mix alone can run to hundreds. */
const LIST_LIMIT = 150;

/**
 * The station editor. It takes the guide's place under the picture, so the
 * programme keeps playing in view while stations are changed.
 */
export function Lineup({ state, dispatch, onClose, history, onUndo, onRestore, focusId, onMenu, className }: LineupProps) {
  const [openId, setOpenId] = useState<string | null>(focusId ?? state.tunedId);
  useEffect(() => {
    if (focusId) setOpenId(focusId);
  }, [focusId]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [mode, setMode] = useState<ChannelMode>("loop");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [pending, setPending] = useState<{ ids: string[]; label: string; matches: Channel[] } | null>(null);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const channels = state.channels.slice().sort((a, b) => a.number - b.number);
  const channel = channels.find((item) => item.id === openId) ?? null;

  /** Put a station at another station's place in the list. Everything between shifts by one; the numbers in use stay the same. */
  function move(fromId: string, toId: string) {
    if (fromId === toId) return;
    const ids = channels.map((item) => item.id).filter((id) => id !== fromId);
    const at = channels.findIndex((item) => item.id === toId);
    const name = channels.find((item) => item.id === fromId)?.name ?? "station";
    ids.splice(at, 0, fromId);
    dispatch({ type: "reorder", ids, label: `Moved ${name} to ${formatStation(channels[at]?.number ?? 0)}` });
  }

  /**
   * Make a station. If one already has the same lineup or the same name, stop
   * and say so first; the warning offers the existing one, or to go ahead anyway.
   */
  function createChannel(ids: string[], label: string, anyway = false) {
    const name = titleCase(label) || "New station";
    const matches = state.channels.filter((item) => lineupKey(item.mediaIds) === lineupKey(ids) || item.name.toLowerCase() === name.toLowerCase());
    if (matches.length > 0 && !anyway) {
      setPending({ ids, label, matches });
      return;
    }
    setPending(null);
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `ch-${Date.now()}`;
    dispatch({ type: "create", id, name, query: label, mediaIds: mode === "loop" ? catalogOrder(ids) : ids, mode, now: Date.now() });
    setOpenId(id);
  }

  /** Renumber every station in a new order. The numbers in use stay the same set, and it can be undone. */
  function sortStations(kind: "az" | "favorites") {
    const sorted = channels
      .slice()
      .sort(
        kind === "az"
          ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
          : (a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || a.number - b.number,
      );
    dispatch({ type: "reorder", ids: sorted.map((item) => item.id), label: kind === "az" ? "Sorted stations A to Z" : "Moved favorites to the top" });
  }

  // Stations with exactly the same lineup as another, so the list can point them out.
  const lineupCount = new Map<string, number>();
  for (const item of channels) lineupCount.set(lineupKey(item.mediaIds), (lineupCount.get(lineupKey(item.mediaIds)) ?? 0) + 1);
  const twinOf = (item: Channel) =>
    (lineupCount.get(lineupKey(item.mediaIds)) ?? 0) > 1
      ? channels.find((other) => other.id !== item.id && lineupKey(other.mediaIds) === lineupKey(item.mediaIds))
      : undefined;

  /** The stations as a file you keep. Loading one back can itself be undone. */
  function saveBackup() {
    const body = JSON.stringify(
      { app: "vayaview", version: 1, savedAt: new Date().toISOString(), folders: libraryInfo.folders, channels: state.channels, hiddenIds: state.hiddenIds ?? [] },
      null,
      2,
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    link.download = `VayaView stations ${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    setBackupNote(`Saved ${state.channels.length} stations to a backup file.`);
  }

  async function loadBackup(file: File) {
    try {
      const data = JSON.parse(await file.text()) as { app?: string; savedAt?: string; channels?: unknown; hiddenIds?: unknown };
      const checked = (data.app === "vayaview" || data.app === "parlor") ? sanitizeState({ ...state, channels: data.channels }) : null;
      if (!checked) throw new Error("not a backup");
      const hidden = Array.isArray(data.hiddenIds) ? data.hiddenIds.filter((id): id is string => typeof id === "string") : [];
      onRestore(checked.channels, hidden, `Loaded backup from ${(data.savedAt ?? "").slice(0, 10) || file.name}`);
      setBackupNote(`Loaded ${checked.channels.length} stations from ${file.name}. Undo puts back what you had.`);
    } catch {
      setBackupNote(`${file.name} is not a VayaView stations backup.`);
    }
  }

  return (
    <section aria-label="Edit stations" className={cn("flex min-h-0 flex-col overflow-hidden rounded-screen bg-bezel text-cream", className)}>
      <header className="flex shrink-0 items-center gap-4 border-b border-screen px-4 py-2">
        <h2 className="text-lg">Edit stations</h2>
        <p className="min-w-0 truncate text-xs text-cream/45">{backupNote ?? "Every change saves as you make it"}</p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={headerButton}
            disabled={history.length === 0}
            onClick={onUndo}
            title={history[0] ? `Undo: ${history[0].label} (Ctrl+Z)` : "Nothing to undo"}
          >
            ↶ Undo{history[0] ? `: ${history[0].label.length > 34 ? `${history[0].label.slice(0, 33)}…` : history[0].label}` : ""}
          </button>
          <button type="button" className={headerButton} onClick={saveBackup} title="Save every station to a file you can load later">
            Save backup…
          </button>
          <button type="button" className={headerButton} onClick={() => fileRef.current?.click()} title="Load stations from a backup file">
            Load backup…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadBackup(file);
              event.target.value = "";
            }}
          />
          <button type="button" onClick={onClose} className={headerButton}>
            Back to guide
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-screen p-2">
          <button
            type="button"
            onClick={() => setOpenId(null)}
            className={cn("mb-1 w-full rounded-lg px-3 py-2 text-left text-sm", channel ? "bg-cream/5 hover:bg-cream/10" : "bg-cream/15")}
          >
            + New station
          </button>
          <div className="mb-2 flex gap-1.5 px-1 text-xs">
            <button type="button" className="rounded-md bg-cream/10 px-2 py-1 text-cream/80 hover:bg-cream/20" onClick={() => sortStations("az")} title="Renumber all stations in alphabetical order (can be undone)">
              Sort A–Z
            </button>
            <button type="button" className="rounded-md bg-cream/10 px-2 py-1 text-cream/80 hover:bg-cream/20" onClick={() => sortStations("favorites")} title="Move favorites to the lowest numbers (can be undone)">
              Favorites first
            </button>
          </div>
          {channels.map((item) => (
            <button
              key={item.id}
              type="button"
              draggable
              title="Drag to move · right-click for color"
              aria-current={item.id === openId ? "true" : undefined}
              onClick={() => {
                setOpenId(item.id);
                setConflict(null);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu?.(item.id, event.clientX, event.clientY);
              }}
              onDragStart={(event) => {
                setDragId(item.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (!dragId) return;
                event.preventDefault();
                setOverId(item.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId) move(dragId, item.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              className={cn(
                "flex w-full cursor-grab items-center gap-2 rounded-lg border-l-4 px-2 py-1.5 text-left text-sm active:cursor-grabbing",
                item.id === openId ? "bg-cream/15" : "hover:bg-cream/5",
                item.id === dragId && "opacity-40",
                // The drop line shows where the dragged station will land.
                overId === item.id && dragId !== item.id && "shadow-[inset_0_2px_0_var(--color-accent)]",
              )}
              style={{ borderLeftColor: item.color ?? (item.favorite ? "var(--color-accent)" : "transparent") }}
            >
              <span className="w-8 shrink-0 text-cream/60 tabular-nums">{formatStation(item.number)}</span>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.favorite ? <span className="text-accent">★</span> : null}
              {twinOf(item) ? (
                <span className="shrink-0 rounded bg-accent/20 px-1 text-[0.65rem] text-accent" title={`Same lineup as ${formatStation(twinOf(item)?.number ?? 0)} ${twinOf(item)?.name}`}>
                  duplicate
                </span>
              ) : null}
              <span className="shrink-0 text-xs text-cream/40 tabular-nums">{item.mediaIds.length}</span>
            </button>
          ))}
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          {channel ? (
            <StationEditor
              key={channel.id}
              channel={channel}
              state={state}
              dispatch={dispatch}
              conflict={conflict}
              setConflict={setConflict}
              onStep={(step) => {
                const at = channels.findIndex((item) => item.id === channel.id);
                const target = channels[at + step];
                if (target) move(channel.id, target.id);
              }}
            />
          ) : (
            <div className="max-w-3xl">
              <p className="text-sm text-cream/70">New station</p>
              <div className="mt-2 mb-3 flex flex-wrap items-center gap-2">
                <button type="button" aria-pressed={mode === "loop"} className={pill(mode === "loop")} onClick={() => setMode("loop")}>
                  In order
                </button>
                <button type="button" aria-pressed={mode === "shuffle"} className={pill(mode === "shuffle")} onClick={() => setMode("shuffle")}>
                  Shuffle
                </button>
                <span className="text-xs text-cream/45">Search, then pick a whole show, one season, one film or every match.</span>
              </div>
              {pending ? (
                <div role="alert" className="mb-3 rounded-lg border border-accent/60 bg-accent/10 p-3 text-sm">
                  <p>
                    ⚠ You already have{" "}
                    {pending.matches.map((item) => `${formatStation(item.number)} ${item.name}`).join(", ")}
                    {pending.matches.some((item) => lineupKey(item.mediaIds) === lineupKey(pending.ids)) ? " with exactly this lineup." : " with this name."}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className={pill(true)} onClick={() => { setOpenId(pending.matches[0]?.id ?? null); setPending(null); }}>
                      Go to {pending.matches[0]?.name}
                    </button>
                    <button type="button" className={pill(false)} onClick={() => createChannel(pending.ids, pending.label, true)}>
                      Make it anyway
                    </button>
                    <button type="button" className="text-xs text-cream/55 underline hover:text-cream" onClick={() => setPending(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              <LibraryPicker verb="Make a station of" onPick={(ids, label) => createChannel(ids, label)} placeholder="A show, a film, a genre, a director, or part of a name" />
              <Suggestions onPick={(ids, label) => createChannel(ids, label)} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

type EditorProps = {
  channel: Channel;
  state: ParlorState;
  dispatch: (action: ParlorAction) => void;
  conflict: Conflict | null;
  setConflict: (value: Conflict | null) => void;
  onStep: (step: -1 | 1) => void;
};

function StationEditor({ channel, state, dispatch, conflict, setConflict, onStep }: EditorProps) {
  const films = channel.mediaIds.map((id) => catalogById.get(id)).filter((film): film is Film => film != null);
  // A station that is one show, start to finish, can be checked for missing episodes.
  const first = films[0];
  const oneShow = first != null && first.genres.includes("TV") && films.every((film) => film.collection === first.collection);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-3">
        <label className="block text-xs text-cream/55">
          Name
          <input defaultValue={channel.name} onBlur={(event) => dispatch({ type: "rename", id: channel.id, name: event.target.value })} className={fieldClass} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-cream/55">
            Number
            <input
              defaultValue={channel.number}
              key={channel.number}
              inputMode="numeric"
              onBlur={(event) => {
                const number = Number(event.target.value);
                const other = state.channels.find((item) => item.id !== channel.id && item.number === number);
                if (other) {
                  setConflict({ number, name: other.name });
                  return;
                }
                setConflict(null);
                dispatch({ type: "number", id: channel.id, number });
              }}
              className={fieldClass}
            />
          </label>
          <label className="block text-xs text-cream/55">
            Call sign
            <input
              defaultValue={channel.callSign}
              maxLength={4}
              onBlur={(event) => dispatch({ type: "callsign", id: channel.id, callSign: event.target.value })}
              className={cn(fieldClass, "tracking-widest uppercase")}
            />
          </label>
        </div>
        {conflict ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-screen px-3 py-2 text-xs">
            <span className="text-accent">
              {formatStation(conflict.number)} is already {conflict.name}.
            </span>
            <button
              type="button"
              className="rounded-md bg-accent px-2.5 py-1 font-medium text-room hover:opacity-90"
              onClick={() => {
                dispatch({ type: "swap-number", id: channel.id, number: conflict.number });
                setConflict(null);
              }}
            >
              Swap: {channel.name} to {formatStation(conflict.number)}, {conflict.name} to {formatStation(channel.number)}
            </button>
            <button type="button" className="text-cream/55 underline hover:text-cream" onClick={() => setConflict(null)}>
              Keep {formatStation(channel.number)}
            </button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-xs text-cream/55">
          Position
          <button type="button" className="rounded-md bg-cream/10 px-2 py-1 text-cream hover:bg-cream/20" onClick={() => onStep(-1)}>
            ▲ Up
          </button>
          <button type="button" className="rounded-md bg-cream/10 px-2 py-1 text-cream hover:bg-cream/20" onClick={() => onStep(1)}>
            ▼ Down
          </button>
          <span>or drag stations in the list on the left</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={Boolean(channel.favorite)} className={pill(Boolean(channel.favorite))} onClick={() => dispatch({ type: "favorite", id: channel.id })}>
            {channel.favorite ? "★ Favorite" : "☆ Add to favorites"}
          </button>
          <span className="ml-1 text-xs text-cream/55">Bar color</span>
          {CHANNEL_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Bar color ${color}`}
              aria-pressed={channel.color === color}
              onClick={() => dispatch({ type: "color", id: channel.id, color })}
              className={cn("size-6 rounded-full", channel.color === color ? "outline-2 outline-offset-2 outline-cream" : "")}
              style={{ backgroundColor: color }}
            />
          ))}
          <button type="button" className="text-xs text-cream/55 underline hover:text-cream" onClick={() => dispatch({ type: "color", id: channel.id, color: null })}>
            none
          </button>
          <ColorInput label="Pick any bar color" value={channel.color} onCommit={(color) => dispatch({ type: "color", id: channel.id, color })} />
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" className={pill(channel.mode === "loop")} onClick={() => dispatch({ type: "mode", id: channel.id, mode: "loop", now: Date.now() })}>
            In order
          </button>
          <button type="button" className={pill(channel.mode === "shuffle")} onClick={() => dispatch({ type: "mode", id: channel.id, mode: "shuffle", now: Date.now() })}>
            Shuffle
          </button>
          <button
            type="button"
            className="h-9 rounded-full bg-room px-3 text-sm text-accent disabled:opacity-40"
            disabled={state.channels.length <= 1}
            onClick={() => dispatch({ type: "delete", id: channel.id })}
          >
            Remove station
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-cream/55">
          <span className="mr-1">Schedule</span>
          {[-30, -5, -1, 1, 5, 30].map((minutes) => (
            <button
              key={minutes}
              type="button"
              title={minutes > 0 ? `Everything airs ${minutes} min later` : `Everything airs ${-minutes} min earlier`}
              onClick={() => dispatch({ type: "shift", id: channel.id, byMs: minutes * 60_000 })}
              className="rounded-md bg-cream/10 px-2 py-1 text-cream tabular-nums hover:bg-cream/20"
            >
              {minutes > 0 ? `+${minutes}m` : `${minutes}m`}
            </button>
          ))}
          <button
            type="button"
            title="Start this station's first programme right now"
            onClick={() => dispatch({ type: "restart", id: channel.id, now: Date.now() })}
            className="rounded-md bg-cream/10 px-2 py-1 text-cream hover:bg-cream/20"
          >
            Start from the top now
          </button>
        </div>
        <p className="text-xs text-cream/45">+ moves everything later, − earlier. Changing the order, or dropping something, starts this station over from now.</p>

        {oneShow ? <EpisodeCheck show={channel.name} films={films} /> : null}

        <div className="rounded-xl bg-screen/60 p-3">
          <p className="mb-2 text-xs text-cream/55">Add to this station, or put back something you dropped</p>
          <LibraryPicker
            verb="Add"
            exclude={new Set(channel.mediaIds)}
            placeholder="Search your library"
            onPick={(ids, label) => {
              const merged = [...channel.mediaIds, ...ids];
              dispatch({
                type: "set-media",
                id: channel.id,
                mediaIds: channel.mode === "loop" ? catalogOrder(merged) : merged,
                now: Date.now(),
                label: `Added ${label} to ${channel.name}`,
              });
            }}
          />
        </div>
      </div>

      <div>
        <p className="text-xs text-cream/55">
          Lineup · {films.length} {films.length === 1 ? "item" : "items"}
        </p>
        <ul className="mt-1">
          {films.slice(0, LIST_LIMIT).map((film) => (
            <li key={film.id} className="flex items-center justify-between gap-2 border-b border-screen text-sm">
              <span className="min-w-0 truncate">
                {film.title} <span className="text-cream/45">{film.year || ""}</span>
              </span>
              <button
                type="button"
                className="h-8 shrink-0 rounded-full px-2 text-xs text-cream/60 hover:text-accent disabled:opacity-30"
                disabled={channel.mediaIds.length <= 1}
                onClick={() => dispatch({ type: "remove-media", id: channel.id, mediaId: film.id, now: Date.now() })}
              >
                Drop
              </button>
            </li>
          ))}
        </ul>
        {films.length > LIST_LIMIT ? <p className="mt-2 text-xs text-cream/45">and {films.length - LIST_LIMIT} more</p> : null}
      </div>
    </div>
  );
}

/**
 * One-click stations from what TMDB knows: a genre with enough films, or a
 * franchise with more than one. Nothing is made until one is clicked.
 */
function Suggestions({ onPick }: { onPick: (ids: string[], label: string) => void }) {
  const movies = CATALOG.filter((film) => film.genres[0] === "Movie");
  const genres = new Map<string, string[]>();
  const sets = new Map<string, string[]>();
  for (const film of movies) {
    for (const genre of film.genres.slice(1)) genres.set(genre, [...(genres.get(genre) ?? []), film.id]);
    if (film.collection) sets.set(film.collection, [...(sets.get(film.collection) ?? []), film.id]);
  }
  const genreList = [...genres].filter(([, ids]) => ids.length >= 5).sort((a, b) => b[1].length - a[1].length);
  const setList = [...sets].filter(([, ids]) => ids.length >= 2).sort((a, b) => a[0].localeCompare(b[0]));
  if (genreList.length === 0 && setList.length === 0) {
    return <p className="mt-4 text-xs text-cream/40">Save a TMDB token under Library folder to get genre and franchise stations here.</p>;
  }
  const chip = "rounded-md bg-cream/10 px-2 py-1 text-xs text-cream hover:bg-accent hover:text-room";
  return (
    <div className="mt-4 space-y-3">
      {genreList.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs text-cream/55">Genres</p>
          <div className="flex flex-wrap gap-1.5">
            {genreList.map(([genre, ids]) => (
              <button key={genre} type="button" className={chip} onClick={() => onPick(ids, `${genre} Movies`)}>
                {genre} · {ids.length}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {setList.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs text-cream/55">Franchises</p>
          <div className="flex flex-wrap gap-1.5">
            {setList.map(([name, ids]) => (
              <button key={name} type="button" className={chip} onClick={() => onPick(ids, name.replace(/ Collection$/, ""))}>
                {name.replace(/ Collection$/, "")} · {ids.length}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}