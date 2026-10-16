import { useEffect, useRef, useState } from "react";
import { durable } from "@/lib/durable";
import type { Film } from "@/lib/library/types";

/**
 * Per-film picture settings, for the odd film that was mastered too dark. Done by the graphics
 * card on the way to the screen, so nothing is re-encoded and the file is never touched.
 */
export type Adjust = { lift: number; brightness: number; contrast: number };
const NEUTRAL: Adjust = { lift: 0, brightness: 1, contrast: 1 };
const key = (id: string) => `parlor.picture:${id}`;
const neutral = (value: Adjust) => value.lift === 0 && value.brightness === 1 && value.contrast === 1;
const clamp = (value: unknown, low: number, high: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

function load(id: string): Adjust {
  try {
    const saved = JSON.parse(durable.getItem(key(id)) ?? "null") as Partial<Adjust> | null;
    if (!saved) return NEUTRAL;
    return { lift: clamp(saved.lift, 0, 0.25, 0), brightness: clamp(saved.brightness, 0.5, 1.5, 1), contrast: clamp(saved.contrast, 0.5, 1.5, 1) };
  } catch {
    return NEUTRAL;
  }
}

/** The settings for the film on screen. Each film keeps its own; a film never set stays untouched. */
export function usePictureAdjust(film: Film | null) {
  const id = film?.id ?? null;
  const [edits, setEdits] = useState<Record<string, Adjust>>({});
  const value = id ? (edits[id] ?? load(id)) : NEUTRAL;
  const pending = useRef(new Map<string, { value: Adjust; timer: number }>());

  function write(film: string) {
    const item = pending.current.get(film);
    if (!item) return;
    pending.current.delete(film);
    window.clearTimeout(item.timer);
    if (neutral(item.value)) durable.removeItem(key(film));
    else durable.setItem(key(film), JSON.stringify(item.value));
  }

  // Anything still waiting is written straight away if this goes away first.
  useEffect(() => () => [...pending.current.keys()].forEach(write), []);

  function set(next: Adjust) {
    if (!id) return;
    setEdits((all) => ({ ...all, [id]: next }));
    // Written once the slider rests, not on every step of a drag.
    window.clearTimeout(pending.current.get(id)?.timer);
    pending.current.set(id, { value: next, timer: window.setTimeout(() => write(id), 400) });
  }

  return { value, film, changed: !neutral(value), set, reset: () => set(NEUTRAL) };
}

export type PictureAdjust = ReturnType<typeof usePictureAdjust>;

const FILTER_ID = "vv-lift";

/** The CSS filter for the video, or nothing when the film is untouched. */
export function videoFilter(value: Adjust): string | undefined {
  if (neutral(value)) return undefined;
  return [value.lift > 0 ? `url(#${FILTER_ID})` : "", value.brightness !== 1 ? `brightness(${value.brightness})` : "", value.contrast !== 1 ? `contrast(${value.contrast})` : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * Lifting the blacks: every level x becomes lift + (1 - lift) * x, so black turns a little grey
 * and white stays white. Worked in sRGB, the way the picture is stored, so the slider feels even.
 */
export function LiftFilter({ lift }: { lift: number }) {
  if (lift <= 0) return null;
  const fn = { type: "linear", slope: 1 - lift, intercept: lift } as const;
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <filter id={FILTER_ID} colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncR {...fn} />
          <feFuncG {...fn} />
          <feFuncB {...fn} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

/** Black level, brightness and contrast for this film only, folded away behind one button. */
export function PictureMenu({ picture, className }: { picture: PictureAdjust; className?: string }) {
  const [open, setOpen] = useState(false);
  const { value, film, changed } = picture;
  if (!film) return null;

  const slider = (label: string, field: keyof Adjust, min: number, max: number, show: (v: number) => string) => (
    <label className="flex min-w-0 items-center gap-2 text-xs text-cream/60">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min * 100}
        max={max * 100}
        value={Math.round(value[field] * 100)}
        onChange={(event) => picture.set({ ...value, [field]: Number(event.target.value) / 100 })}
        aria-label={label}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-accent"
      />
      <span className="w-10 shrink-0 text-right tabular-nums">{show(value[field])}</span>
    </label>
  );

  return (
    <div className={className}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-cream/60">
        <span className="w-16 shrink-0">Picture</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={changed ? "rounded-md bg-accent px-2 py-1 text-xs font-semibold text-room" : "rounded-md bg-cream/10 px-2 py-1 text-xs text-cream/80 hover:bg-cream/20"}
        >
          {changed ? "Adjusted for this film" : "Adjust"}
        </button>
        {changed ? (
          <button type="button" onClick={picture.reset} className="text-xs text-cream/50 hover:text-cream">
            Reset
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-1.5 rounded-lg bg-black/40 p-2">
          {slider("Black level", "lift", 0, 0.25, (v) => `+${Math.round(v * 100)}`)}
          {slider("Brightness", "brightness", 0.5, 1.5, (v) => `${Math.round(v * 100)}%`)}
          {slider("Contrast", "contrast", 0.5, 1.5, (v) => `${Math.round(v * 100)}%`)}
          <p className="text-[0.7rem] text-cream/45">Only for {film.title}. Other films stay as they are.</p>
        </div>
      ) : null}
    </div>
  );
}
