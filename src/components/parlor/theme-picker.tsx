import { useState } from "react";
import { cn } from "@/lib/cn";
import { applyTheme, loadTheme, THEMES, type ThemeChoice } from "@/lib/theme";
import { ColorInput } from "./color-input";

/** Eight ready-made themes, plus any highlight colour on top of the chosen one. */
export function ThemePicker() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  const theme = THEMES.find((item) => item.id === choice.id) ?? THEMES[0]!;

  function pick(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next);
  }

  return (
    <div className="px-1 pb-1">
      <div className="flex flex-wrap items-center gap-2">
        {THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.name}
            aria-label={`${item.name} theme`}
            aria-pressed={item.id === choice.id && !choice.accent}
            onClick={() => pick({ id: item.id, accent: null })}
            className={cn(
              "size-7 rounded-full border-4",
              item.id === choice.id && !choice.accent ? "outline-2 outline-offset-2 outline-cream" : "",
            )}
            style={{ backgroundColor: item.accent, borderColor: item.bezel }}
          />
        ))}
        <span className="ml-2">
          <ColorInput label="Custom highlight colour" text="Custom" value={choice.accent ?? theme.accent} onCommit={(color) => pick({ id: choice.id, accent: color })} />
        </span>
      </div>
      <p className="mt-1 text-xs text-cream/40">
        {choice.accent ? `${theme.name} with a custom highlight` : theme.name} · saved for next time
      </p>
    </div>
  );
}
