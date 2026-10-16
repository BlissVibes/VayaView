import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { applyTheme, hexToHsv, hsvToHex, loadTheme, roomShades, THEMES, type Hsv, type ThemeChoice } from "@/lib/theme";
import { ColorInput } from "./color-input";

/** Eight ready-made themes, plus any highlight colour and any background on top of the chosen one. */
export function ThemePicker() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  const theme = THEMES.find((item) => item.id === choice.id) ?? THEMES[0]!;

  function pick(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next);
  }

  const custom = [choice.accent ? "a custom highlight" : "", choice.room ? "a custom background" : ""].filter(Boolean).join(" and ");
  return (
    <div className="px-1 pb-1">
      <div className="flex flex-wrap items-center gap-2">
        {THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.name}
            aria-label={`${item.name} theme`}
            aria-pressed={item.id === choice.id && !choice.accent && !choice.room}
            // A new theme brings its own background too.
            onClick={() => pick({ id: item.id, accent: null, room: null })}
            className={cn(
              "size-7 rounded-full border-4",
              item.id === choice.id && !choice.accent && !choice.room ? "outline-2 outline-offset-2 outline-cream" : "",
            )}
            style={{ backgroundColor: item.accent, borderColor: item.bezel }}
          />
        ))}
        <span className="ml-2">
          <ColorInput label="Custom highlight colour" text="Custom" value={choice.accent ?? theme.accent} onCommit={(color) => pick({ ...choice, accent: color })} />
        </span>
      </div>
      <p className="mt-1 text-xs text-cream/40">
        {custom ? `${theme.name} with ${custom}` : theme.name} · saved for next time
      </p>
      <Background
        value={choice.room ?? theme.room}
        custom={choice.room != null}
        onApply={(room) => pick({ ...choice, room })}
        onReset={() => pick({ ...choice, room: null })}
      />
    </div>
  );
}

type BackgroundProps = { value: string; custom: boolean; onApply: (room: string) => void; onReset: () => void };

/** Hue, saturation and brightness for the window background. Nothing changes until Apply. */
function Background({ value, custom, onApply, onReset }: BackgroundProps) {
  const [draft, setDraft] = useState<Hsv>(() => hexToHsv(value));
  useEffect(() => setDraft(hexToHsv(value)), [value]);
  const hex = hsvToHex(draft);
  const shades = roomShades(hex);
  const changed = hex !== value.toLowerCase();

  const slider = (key: keyof Hsv, label: string, max: number, scale: number, track: string) => (
    <label className="flex items-center gap-2 text-xs text-cream/60">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={0}
        max={max}
        value={Math.round(draft[key] * scale)}
        onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) / scale })}
        aria-label={`Background ${label.toLowerCase()}`}
        className="h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full accent-cream"
        style={{ background: track }}
      />
      <span className="w-9 shrink-0 text-right tabular-nums">{Math.round(draft[key] * scale)}</span>
    </label>
  );
  const bright = hsvToHex({ ...draft, v: 1 });

  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs text-cream/70">Background</p>
      <div className="flex items-start gap-3">
        {/* The background with a panel and a well on it, as they will look. */}
        <div className="flex h-[4.5rem] w-24 shrink-0 items-end rounded-lg p-1.5 ring-1 ring-cream/20" style={{ backgroundColor: hex }} aria-hidden>
          <div className="h-8 w-full rounded-md p-1" style={{ backgroundColor: shades.bezel }}>
            <div className="h-full w-2/3 rounded-sm" style={{ backgroundColor: shades.screen }} />
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          {slider("h", "Hue", 360, 1, "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)")}
          {slider("s", "Saturation", 100, 100, `linear-gradient(to right, ${hsvToHex({ ...draft, s: 0, v: 0.6 })}, ${hsvToHex({ h: draft.h, s: 1, v: 0.6 })})`)}
          {slider("v", "Brightness", 100, 100, `linear-gradient(to right, #000, ${bright})`)}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!changed}
          onClick={() => onApply(hex)}
          className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-room hover:opacity-90 disabled:opacity-40"
        >
          Apply
        </button>
        {changed ? (
          <button type="button" className="rounded-md px-2.5 py-1 text-xs text-cream/60 hover:text-cream" onClick={() => setDraft(hexToHsv(value))}>
            Cancel
          </button>
        ) : null}
        {custom ? (
          <button type="button" className="ml-auto text-xs text-cream/50 underline-offset-2 hover:text-cream hover:underline" onClick={onReset}>
            Reset to theme
          </button>
        ) : null}
      </div>
    </div>
  );
}
