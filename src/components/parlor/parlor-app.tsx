import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/cn";
import { formatDuration, formatStation, formatTime } from "@/lib/format";
import type { Film } from "@/lib/library/types";
import { playRequestFor } from "@/lib/player/seam";
import type { Airing } from "@/lib/schedule/types";
import { catalogById } from "@/lib/library/catalog";
import { isRemote } from "@/lib/remote";
import { GuideGrid } from "./guide-grid";
import { Lineup } from "./lineup";
import { Picture } from "./picture";
import { SeekBar } from "./seek-bar";
import { StationMenu } from "./station-menu";
import { Settings } from "./settings";
import { TrackMenu, useTracks } from "./tracks";
import { scheduleLibrary, useParlor } from "./use-parlor";
import { durable } from "@/lib/durable";

const buttonClass = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20";
/** The everyday buttons (Last, Full view, Edit stations): heavier, so they stand out from the rest. */
const primaryClass = "rounded-md bg-cream/20 px-3 py-1.5 text-xs font-semibold text-cream ring-1 ring-cream/25 hover:bg-cream/30 disabled:opacity-40";

/**
 * A programme the viewer has scrubbed. It is the same airing with its own
 * start time, held here and nowhere else: not saved, not in the schedule.
 * Changing channel, reaching the end, or pressing Live lets go of it.
 */
type Held = { channelId: string; airing: Airing; film: Film; startMs: number };

/**
 * Two views of one set. The guide keeps the picture playing in the corner
 * above the listings. Full view is only the picture. G or a double click
 * switches. The player is the same element in both, so switching never reloads it.
 */
export function ParlorApp() {
  const parlor = useParlor();
  const { state, channel, now } = parlor;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A newer version on GitHub puts a dot on the Settings button.
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    if (isRemote) return;
    fetch("/api/update")
      .then((response) => response.json() as Promise<{ available?: boolean }>)
      .then((status) => setUpdateReady(Boolean(status.available)))
      .catch(() => {});
  }, []);
  // On a phone: show what the PC is showing, until the phone picks a station of its own.
  const [follow, setFollow] = useState(isRemote);
  const full = parlor.overlay === "none";
  const editing = parlor.overlay === "lineup";
  const toggleView = () => parlor.setOverlay(full ? "guide" : "none");

  const [held, setHeld] = useState<Held | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const openMenu = (id: string, x: number, y: number) => setMenu({ id, x, y });
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuChannel = menu ? state.channels.find((item) => item.id === menu.id) : undefined;
  const [scan, setScan] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);

  async function rescan() {
    setScan("Scanning…");
    // New files are measured once each. Show how far along that is.
    const poll = window.setInterval(() => {
      fetch("/api/status")
        .then((response) => response.json() as Promise<{ phase: string; done: number; total: number }>)
        .then((status) => setScan(status.phase === "probing" && status.total > 0 ? `Measuring ${status.done} of ${status.total}…` : "Scanning…"))
        .catch(() => {});
    }, 700);
    const result = await parlor.rescan();
    window.clearInterval(poll);
    setScan(null);
    setScanNote(
      result.error
        ? `Rescan failed: ${result.error}`
        : result.added || result.removed
          ? `Library rescanned · ${result.added} new, ${result.removed} gone`
          : "Library rescanned · no changes",
    );
    window.setTimeout(() => setScanNote(null), 3500);
  }
  const [seekToken, setSeekToken] = useState(0);
  const live = parlor.airing;

  // What the picture shows: the station's clock, unless the viewer is holding a scrubbed programme.
  let airing = live;
  let film = parlor.film;
  let shifted = false;
  if (held && channel && held.channelId === channel.id && state.powered && now != null) {
    const length = held.airing.slot.durationMs;
    const offset = now - held.startMs;
    if (offset < length - 1000) {
      const at = Math.max(0, offset);
      airing = { ...held.airing, offsetMs: at, remainingMs: length - at, startedAtMs: held.startMs, endsAtMs: held.startMs + length };
      film = held.film;
      shifted = true;
    }
  }
  const request = airing ? playRequestFor(airing, film) : null;
  const tracks = useTracks(film);

  useEffect(() => {
    if (held && !shifted && now != null) setHeld(null);
  }, [held, shifted, now]);

  const sameProgramme =
    live != null && airing != null && live.slot.mediaId === airing.slot.mediaId && live.slotIndex === airing.slotIndex && live.cycleIndex === airing.cycleIndex;
  const behindMs = shifted && sameProgramme && live && airing ? live.offsetMs - airing.offsetMs : null;

  // The PC tells the house what it is showing. A following phone reads it every two seconds.
  const nowKey = `${state.tunedId}|${state.powered}|${held?.startMs ?? ""}|${held?.channelId ?? ""}`;
  useEffect(() => {
    if (isRemote) return;
    void fetch("/api/now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: state.tunedId,
        powered: state.powered,
        held: held ? { channelId: held.channelId, mediaId: held.film.id, startMs: held.startMs, airing: held.airing } : null,
      }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowKey sums up everything sent
  }, [nowKey]);

  const followRef = useRef({ tunedId: state.tunedId, held });
  followRef.current = { tunedId: state.tunedId, held };
  useEffect(() => {
    if (!isRemote || !follow) return;
    const sync = async () => {
      const pc = (await fetch("/api/now").then((response) => response.json()).catch(() => null)) as {
        channelId?: string;
        held?: { channelId: string; mediaId: string; startMs: number; airing: Airing } | null;
      } | null;
      if (!pc?.channelId) return;
      const mine = followRef.current;
      if (pc.channelId !== mine.tunedId) parlor.dispatch({ type: "tune", id: pc.channelId });
      const film = pc.held ? catalogById.get(pc.held.mediaId) : undefined;
      if (pc.held && film && pc.held.startMs !== mine.held?.startMs) {
        setHeld({ channelId: pc.held.channelId, airing: pc.held.airing, film, startMs: pc.held.startMs });
        setSeekToken((value) => value + 1);
      } else if (!pc.held && mine.held) {
        setHeld(null);
        setSeekToken((value) => value + 1);
      }
    };
    void sync();
    // Often enough that a channel change on the PC shows up on the phone in under a second.
    const timer = window.setInterval(sync, 700);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parlor.dispatch is stable
  }, [follow]);

  function goLive() {
    setHeld(null);
    setSeekToken((value) => value + 1);
  }

  function seekTo(ms: number) {
    if (!channel || !airing || !film || airing.slot.status !== "ready") return;
    const at = Math.min(Math.max(0, ms), airing.slot.durationMs - 5000);
    // Landing back on the clock is just being live again.
    if (sameProgramme && live && Math.abs(at - live.offsetMs) < 3000) return goLive();
    setHeld({ channelId: channel.id, airing, film, startMs: Date.now() - at });
    setSeekToken((value) => value + 1);
  }

  const seekRef = useRef({ seekTo, offset: 0 });
  seekRef.current = { seekTo, offset: airing?.offsetMs ?? 0 };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") seekRef.current.seekTo(seekRef.current.offset - 10_000);
      if (event.key === "ArrowRight") seekRef.current.seekTo(seekRef.current.offset + 30_000);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The picture's share of the window width, set by dragging its corner. The guide gets what is left.
  const mainRef = useRef<HTMLElement>(null);
  const [split, setSplit] = useState(() => {
    const saved = Number(durable.getItem("parlor.split"));
    return saved >= 25 && saved <= 78 ? saved : 46;
  });
  useEffect(() => {
    durable.setItem("parlor.split", String(Math.round(split)));
  }, [split]);

  function startResize(event: ReactPointerEvent) {
    event.preventDefault();
    const main = mainRef.current;
    if (!main) return;
    const box = main.getBoundingClientRect();
    const pad = 12;
    const move = (at: PointerEvent) => {
      // The corner follows the pointer along the diagonal, and always leaves a few rows of guide.
      const byX = at.clientX - box.left - pad;
      const byY = ((at.clientY - box.top - pad) * 16) / 9;
      const width = Math.min((byX + byY) / 2, ((box.height - 190) * 16) / 9);
      setSplit(Math.min(78, Math.max(25, (width / (box.width - pad * 2)) * 100)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  // Back to the station you were on before this one. Backspace does the same.
  const lastChannel = state.lastId ? state.channels.find((item) => item.id === state.lastId) : undefined;
  const lastButton = (
    <button
      type="button"
      className={primaryClass}
      disabled={!lastChannel}
      title={lastChannel ? `Back to ${formatStation(lastChannel.number)} ${lastChannel.name} (Backspace)` : "No previous station yet"}
      onClick={() => lastChannel && parlor.dispatch({ type: "tune", id: lastChannel.id })}
    >
      ↩ Last{lastChannel ? ` · ${formatStation(lastChannel.number)}` : ""}
    </button>
  );

  const canSeek = state.powered && airing != null && film != null && airing.slot.status === "ready" && film.filePath != null;
  const seekBar = (className: string) =>
    canSeek && airing ? (
      <SeekBar
        className={className}
        offsetMs={airing.offsetMs}
        durationMs={airing.slot.durationMs}
        shifted={shifted}
        behindMs={behindMs}
        onSeek={seekTo}
        onLive={goLive}
      />
    ) : null;

  return (
    <main ref={mainRef} className="flex h-dvh flex-col gap-3 p-3">
      <p className="sr-only" aria-live="polite">
        {channel && airing ? `Station ${channel.number}. ${airing.slot.title}.` : "Joining the broadcast."}
      </p>

      <div
        className={full ? "" : isRemote ? "flex shrink-0 flex-col gap-3" : "grid shrink-0 gap-3"}
        style={full || isRemote ? undefined : { gridTemplateColumns: `minmax(0, ${split}%) minmax(0, 1fr)` }}
      >
        <div className={full ? "fixed inset-0 z-40 bg-black" : "group/picture relative aspect-video overflow-hidden rounded-screen"}>
          {full || isRemote ? null : (
            <div
              role="separator"
              aria-label="Drag to resize the picture"
              title="Drag to resize"
              onPointerDown={startResize}
              className="absolute right-0 bottom-0 z-30 size-6 cursor-nwse-resize opacity-0 transition-opacity group-hover/picture:opacity-50 hover:!opacity-75"
              style={{ background: "linear-gradient(135deg, transparent 50%, var(--color-accent) 50%)" }}
            />
          )}
          <Picture
            powered={state.powered}
            channel={channel}
            airing={airing}
            film={film}
            request={request}
            digits={parlor.digits}
            notice={parlor.notice}
            audio={tracks.audio}
            sub={tracks.sub}
            compact={!full}
            seekToken={seekToken}
            onToggleView={toggleView}
            toolbar={
              <div className="flex items-start gap-3">
                <TrackMenu tracks={tracks} className="flex flex-col gap-1.5" />
                {lastButton}
                <button type="button" className={buttonClass} onClick={toggleView}>
                  Guide
                </button>
              </div>
            }
            footer={seekBar("rounded-lg bg-black/55 px-3 py-2")}
          />
        </div>

        {full ? null : (
          <section aria-label="On now" className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-screen bg-bezel p-5">
            <div className="flex items-start justify-between gap-4">
              <p className="text-xs tracking-[0.2em] text-cream/60 uppercase">
                {channel ? `${channel.callSign} · ${channel.name}` : "VayaView"}
              </p>
              <p className="text-sm text-cream/60 tabular-nums">{now != null ? formatTime(now) : ""}</p>
            </div>

            <div className="mt-3 flex items-baseline gap-4">
              <p className="font-title text-5xl leading-none font-semibold tracking-tight text-accent tabular-nums">
                {channel ? formatStation(channel.number) : "--"}
              </p>
              <h1 className="font-title min-w-0 text-2xl leading-tight font-semibold tracking-tight text-cream xl:text-3xl">
                {!state.powered ? "Standby" : (airing?.slot.title ?? "Joining the broadcast")}
              </h1>
            </div>

            {airing && state.powered ? (
              <>
                {seekBar("mt-4") ?? (
                  <div className="mt-4 h-1 overflow-hidden rounded-full bg-cream/15">
                    <div className="h-full bg-accent" style={{ width: `${Math.min(100, (airing.offsetMs / airing.slot.durationMs) * 100)}%` }} />
                  </div>
                )}
                <p className="mt-2 text-sm text-cream/70 tabular-nums">
                  {film?.year ? `${film.year} · ` : ""}
                  {formatDuration(airing.remainingMs)} left · ends {formatTime(airing.endsAtMs)}
                </p>
                <p className="mt-1 truncate text-sm text-cream/50">
                  {shifted && !sameProgramme && live
                    ? `Live on this station now · ${live.slot.title}`
                    : airing.next
                      ? `Next · ${airing.next.title}`
                      : ""}
                </p>
              </>
            ) : null}

            <TrackMenu tracks={tracks} className="mt-4 flex flex-col gap-2" />

            <div className="mt-auto pt-4">
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {lastButton}
                <button type="button" className={primaryClass} onClick={toggleView}>
                  Full view
                </button>
                {isRemote ? (
                  <button
                    type="button"
                    className={follow ? `${buttonClass} bg-accent text-room hover:bg-accent` : buttonClass}
                    aria-pressed={follow}
                    onClick={() => setFollow((value) => !value)}
                  >
                    {follow ? "● Following PC" : "Follow PC"}
                  </button>
                ) : null}
                {isRemote ? null : (
                <>
                <button
                  type="button"
                  className={primaryClass}
                  onClick={() => {
                    setEditId(null);
                    setSettingsOpen(false);
                    parlor.setOverlay(editing ? "guide" : "lineup");
                  }}
                >
                  {editing ? "Back to guide" : "Edit stations"}
                </button>
                <button
                  type="button"
                  className={cn(buttonClass, "relative")}
                  onClick={() => {
                    if (editing) parlor.setOverlay("guide");
                    setSettingsOpen((open) => !open);
                  }}
                >
                  {settingsOpen ? "Back to guide" : "Settings"}
                  {updateReady ? <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-accent" title="An update is ready" /> : null}
                </button>
                </>
                )}
              </div>
              <p className="mt-2 hidden text-xs text-cream/35 xl:block">↑↓ station · Backspace last · ←→ scrub · G full view · F full screen · M mute</p>
            </div>
          </section>
        )}
      </div>

      {full || now == null ? null : settingsOpen ? (
        <Settings className="flex-1" onClose={() => setSettingsOpen(false)} onRescan={rescan} scanLabel={scan} onRefresh={parlor.rescan} />
      ) : editing ? (
        <Lineup
          className="flex-1"
          state={state}
          dispatch={parlor.dispatch}
          onClose={() => parlor.setOverlay("guide")}
          history={parlor.history}
          onUndo={parlor.undo}
          onRestore={parlor.restore}
          focusId={editId}
          onMenu={openMenu}
        />
      ) : (
        <GuideGrid
          className="flex-1"
          channels={state.channels}
          tunedId={state.tunedId}
          now={now}
          missing={parlor.missing}
          library={scheduleLibrary}
          onTune={(id) => {
            // Picking a station on the phone means it stops following the PC.
            if (isRemote) setFollow(false);
            parlor.dispatch({ type: "tune", id });
          }}
          narrow={isRemote}
          onFavorite={(id) => parlor.dispatch({ type: "favorite", id })}
          onMenu={openMenu}
        />
      )}

      {menu && menuChannel ? (
        <StationMenu
          channel={menuChannel}
          x={menu.x}
          y={menu.y}
          dispatch={parlor.dispatch}
          onClose={closeMenu}
          onEdit={() => {
            setEditId(menuChannel.id);
            setSettingsOpen(false);
            parlor.setOverlay("lineup");
          }}
        />
      ) : null}

      {parlor.saved || scanNote ? (
        <p
          role="status"
          className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-room shadow-lg"
        >
          {scanNote ?? (parlor.saved === "Saved" ? "✓ Saved" : parlor.saved)}
        </p>
      ) : null}
    </main>
  );
}
