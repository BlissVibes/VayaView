import { useState } from "react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";

type SeekBarProps = {
  offsetMs: number;
  durationMs: number;
  /** True when the picture has been moved off the station's clock. */
  shifted: boolean;
  /** How far behind (positive) or ahead of the live broadcast. Null once live has moved on to another programme. */
  behindMs: number | null;
  onSeek: (ms: number) => void;
  onLive: () => void;
  /** The picture is stopped on this frame. The station's clock keeps running underneath. */
  paused?: boolean;
  onPause?: () => void;
  /** Another video of this station at its surf point (S). Only on stations with a surf mode. */
  onSurf?: () => void;
  className?: string;
};

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** "40s" under a minute, "12m" after. */
const span = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : formatDuration(ms));

const stepClass = "rounded-md bg-cream/10 px-2 py-1 text-xs text-cream hover:bg-cream/20";

/**
 * Scrubbing is a look, not an edit. The station's clock keeps running
 * underneath, nothing here is saved, and Live always drops back onto it.
 */
export function SeekBar({ offsetMs, durationMs, shifted, behindMs, onSeek, onLive, paused = false, onPause, onSurf, className }: SeekBarProps) {
  // While the thumb is held, show where it is without restarting the picture on every pixel.
  const [drag, setDrag] = useState<number | null>(null);
  const at = drag ?? offsetMs;

  function commit() {
    if (drag == null) return;
    onSeek(drag);
    setDrag(null);
  }

  const where =
    behindMs == null
      ? "the station has moved on"
      : behindMs >= 0
        ? `${span(behindMs)} behind live`
        : `${span(-behindMs)} ahead of live`;

  return (
    <div className={className}>
      <input
        type="range"
        aria-label="Position in this programme"
        min={0}
        max={Math.max(1, durationMs)}
        step={1000}
        value={at}
        onChange={(event) => setDrag(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="h-1.5 w-full cursor-pointer accent-accent"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-cream/70 tabular-nums">
        {onPause ? (
          <button type="button" className={cn(stepClass, paused && "bg-accent text-room hover:bg-accent")} onClick={onPause} aria-pressed={paused} title={paused ? "Play (Space)" : "Pause (Space)"}>
            {paused ? "▶ Play" : "❚❚ Pause"}
          </button>
        ) : null}
        <span>
          {clock(at)} / {clock(durationMs)}
        </span>
        <button type="button" className={stepClass} onClick={() => onSeek(offsetMs - 10_000)} title="Back 10 seconds (←)">
          −10s
        </button>
        <button type="button" className={stepClass} onClick={() => onSeek(offsetMs + 30_000)} title="Forward 30 seconds (→)">
          +30s
        </button>
        {onSurf ? (
          <button type="button" className={stepClass} onClick={onSurf} title="Another video of this station, at its surf point (S)">
            ⤳ Surf
          </button>
        ) : null}
        <span className="ml-auto">{paused ? `Paused · ${where}` : shifted ? where : ""}</span>
        <button
          type="button"
          onClick={onLive}
          disabled={!shifted}
          title="Return to where this station is right now"
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-semibold tracking-wider",
            shifted ? "bg-accent text-room hover:opacity-90" : "bg-cream/10 text-accent",
          )}
        >
          {shifted ? "BACK TO LIVE" : "● LIVE"}
        </button>
      </div>
    </div>
  );
}
