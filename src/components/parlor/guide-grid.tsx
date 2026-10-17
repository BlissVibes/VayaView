import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { durable } from "@/lib/durable";
import { cn } from "@/lib/cn";
import { formatStation, formatTime } from "@/lib/format";
import { guideFrom } from "@/lib/schedule/engine";
import type { Channel, Schedulable } from "@/lib/schedule/types";

type GuideGridProps = {
  channels: Channel[];
  tunedId: string;
  now: number;
  missing: ReadonlySet<string>;
  library: ReadonlyMap<string, Schedulable>;
  onTune: (id: string) => void;
  onFavorite: (id: string) => void;
  /** Right-click on a station. */
  onMenu: (id: string, x: number, y: number) => void;
  /** Phone width: a slimmer station column, no favorite stars. */
  narrow?: boolean;
  className?: string;
};

const HALF_HOUR = 30 * 60_000;
/** How much of the evening the grid shows. */
const WINDOW_MS = 5 * HALF_HOUR;

/**
 * The listings. One row per station, time running left to right from the last
 * half hour. Clicking anywhere on a row tunes that station live. It never
 * starts a later programme early.
 */
export function GuideGrid({ channels, tunedId, now, missing, library, onTune, onFavorite, onMenu, narrow, className }: GuideGridProps) {
  // The station column is as wide as the user drags it (like a panel edge in Premiere). Remembered.
  const [columnPx, setColumnPx] = useState(() => {
    const saved = Number(durable.getItem("parlor.guideColumn"));
    return saved >= 140 && saved <= 560 ? saved : 240;
  });
  const stationWidth = narrow ? "w-32" : "";
  const stationStyle = narrow ? undefined : { width: columnPx };

  function startColumnDrag(event: ReactPointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnPx;
    let latest = startWidth;
    const move = (at: PointerEvent) => {
      latest = Math.min(560, Math.max(140, startWidth + at.clientX - startX));
      setColumnPx(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      durable.setItem("parlor.guideColumn", String(Math.round(latest)));
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }
  const start = Math.floor(now / HALF_HOUR) * HALF_HOUR;
  const tunedRow = useRef<HTMLDivElement>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const anyFavorite = channels.some((channel) => channel.favorite);
  const filtered = onlyFavorites && anyFavorite;

  const rows = useMemo(
    () =>
      channels
        .filter((channel) => !filtered || channel.favorite)
        .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name))
        .map((channel) => ({ channel, slots: guideFrom(channel, library, missing, start, WINDOW_MS) })),
    [channels, filtered, library, missing, start],
  );

  useEffect(() => {
    tunedRow.current?.scrollIntoView({ block: "nearest" });
  }, [tunedId]);

  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const ticks = Array.from({ length: WINDOW_MS / HALF_HOUR }, (_, i) => start + i * HALF_HOUR);
  const nowAt = ((now - start) / WINDOW_MS) * 100;

  return (
    <section aria-label="Guide" className={cn("relative flex min-h-0 flex-col overflow-hidden rounded-screen bg-bezel", className)}>
      {narrow ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to change the width of the station names"
          title="Drag to widen or narrow the station names"
          onPointerDown={startColumnDrag}
          className="group absolute top-0 bottom-0 z-20 w-2.5 -translate-x-1/2 cursor-col-resize"
          style={{ left: columnPx }}
        >
          <div className="mx-auto h-full w-px bg-cream/10 group-hover:w-0.5 group-hover:bg-accent" />
        </div>
      )}
      <div className="flex shrink-0 border-b border-screen text-xs text-cream/60">
        <div className={cn("flex shrink-0 items-center justify-between px-3 py-1.5", stationWidth)} style={stationStyle}>
          <p className="tracking-[0.18em] uppercase">Stations</p>
          <button
            type="button"
            aria-pressed={filtered}
            disabled={!anyFavorite}
            title={anyFavorite ? "Show only favorites" : "Star a station to make it a favorite"}
            onClick={() => setOnlyFavorites((value) => !value)}
            className={cn("rounded-md px-2 py-0.5", filtered ? "bg-accent text-room" : "bg-cream/10 text-cream/70 hover:bg-cream/20 disabled:opacity-40")}
          >
            ★ Favorites
          </button>
        </div>
        <div className="relative flex min-w-0 flex-1">
          {ticks.map((tick) => (
            <p key={tick} className="flex-1 border-l border-screen px-2 py-2 tabular-nums">
              {formatTime(tick)}
            </p>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(({ channel, slots }) => {
          const tuned = channel.id === tunedId;
          // A channel "Surf the tube" made sits under its station: indented, and in the station's colour unless it has its own.
          const parent = channel.parentId ? byId.get(channel.parentId) : undefined;
          // A station's own colour, or the theme highlight for a favourite that has none. Others stay plain.
          const color = channel.color ?? parent?.color ?? (channel.favorite ? "var(--color-accent)" : null);
          return (
            <div
              key={channel.id}
              ref={tuned ? tunedRow : undefined}
              role="button"
              tabIndex={-1}
              aria-current={tuned ? "true" : undefined}
              onClick={() => onTune(channel.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(channel.id, event.clientX, event.clientY);
              }}
              className={cn("flex h-12 border-b border-screen", tuned ? "bg-cream/10" : "hover:bg-cream/5")}
            >
              <div
                className={cn("flex shrink-0 items-center gap-3 border-l-[6px] pr-1 pl-3", stationWidth)}
                style={{
                  width: narrow ? undefined : columnPx,
                  borderLeftColor: color ?? (tuned ? "var(--color-cream)" : "transparent"),
                  backgroundColor: color ? `color-mix(in srgb, ${color} ${channel.favorite ? 30 : 14}%, transparent)` : undefined,
                }}
              >
                <p className={cn("font-title w-9 text-xl leading-none font-semibold tracking-tight tabular-nums", tuned ? "text-cream" : "text-cream/80")}>
                  {formatStation(channel.number)}
                </p>
                <div className={cn("min-w-0 flex-1", channel.parentId ? "pl-3" : "")}>
                  <p className={cn("truncate text-sm text-cream", tuned ? "font-semibold" : "")}>
                    {channel.parentId ? <span className="mr-1 text-cream/45">↳</span> : null}
                    {channel.name}
                  </p>
                  <p className="text-[0.65rem] tracking-[0.16em] text-cream/40">{channel.callSign}</p>
                </div>
                {narrow ? null : (
                <button
                  type="button"
                  aria-pressed={Boolean(channel.favorite)}
                  aria-label={channel.favorite ? `Remove ${channel.name} from favorites` : `Add ${channel.name} to favorites`}
                  title={channel.favorite ? "Remove from favorites" : "Add to favorites"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFavorite(channel.id);
                  }}
                  className={cn("size-8 shrink-0 rounded-md text-base hover:bg-cream/15", channel.favorite ? "" : "text-cream/25 hover:text-cream/70")}
                  style={channel.favorite ? { color: color ?? undefined } : undefined}
                >
                  {channel.favorite ? "★" : "☆"}
                </button>
                )}
              </div>

              <div className="relative min-w-0 flex-1">
                {slots.map((item) => {
                  const left = Math.max(0, ((item.startsAtMs - start) / WINDOW_MS) * 100);
                  const right = Math.min(100, ((item.endsAtMs - start) / WINDOW_MS) * 100);
                  if (right <= left) return null;
                  const onNow = item.startsAtMs <= now && now < item.endsAtMs;
                  return (
                    <div
                      key={`${item.slot.mediaId}-${item.startsAtMs}`}
                      title={`${item.slot.title} · ${formatTime(item.startsAtMs)} to ${formatTime(item.endsAtMs)}`}
                      style={{
                        left: `${left}%`,
                        width: `${right - left}%`,
                        // The programme on now carries the station's colour, so a favourite reads across the whole row.
                        backgroundColor: onNow && !tuned && color ? `color-mix(in srgb, ${color} 45%, transparent)` : undefined,
                      }}
                      className={cn(
                        "absolute top-1 bottom-1 flex items-center overflow-hidden rounded-md border-x-2 border-bezel px-2 text-xs",
                        onNow && tuned ? "bg-accent text-room" : onNow ? "bg-cream/20 text-cream" : "bg-cream/[0.07] text-cream/60",
                        item.slot.status === "missing" ? "slot-missing" : "",
                      )}
                    >
                      <span className="truncate">{item.slot.title}</span>
                    </div>
                  );
                })}
                <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent" style={{ left: `${nowAt}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
