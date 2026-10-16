import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatStation } from "@/lib/format";
import type { ParlorAction } from "@/lib/library/reducer";
import type { Channel } from "@/lib/schedule/types";
import { CHANNEL_COLORS } from "@/lib/theme";
import { ColorInput } from "./color-input";

type StationMenuProps = {
  channel: Channel;
  x: number;
  y: number;
  dispatch: (action: ParlorAction) => void;
  onEdit: () => void;
  onClose: () => void;
};

const item = "w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-cream/10";

/** Right-click on a station: its bar colour, favourite, and a way into the editor. */
export function StationMenu({ channel, x, y, dispatch, onEdit, onClose }: StationMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    // No close on window blur: the system colour picker takes focus, and the menu must still be there when it reports.
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // Keep the menu inside the window when the click was near an edge.
  const left = Math.min(x, window.innerWidth - 244);
  const top = Math.min(y, window.innerHeight - 290);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${channel.name} options`}
      className="fixed z-[90] w-60 rounded-xl border border-cream/10 bg-bezel p-2 text-cream shadow-2xl"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="truncate px-2 pt-1 pb-2 text-xs text-cream/55">
        {formatStation(channel.number)} · {channel.name}
      </p>
      <p className="px-2 text-xs text-cream/55">Bar color</p>
      <div className="flex flex-wrap gap-1.5 px-2 py-2">
        {CHANNEL_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="menuitemradio"
            aria-checked={channel.color === color}
            aria-label={`Color ${color}`}
            onClick={() => {
              dispatch({ type: "color", id: channel.id, color });
              onClose();
            }}
            className={cn("size-6 rounded-full", channel.color === color ? "outline-2 outline-offset-2 outline-cream" : "")}
            style={{ backgroundColor: color }}
          />
        ))}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={!channel.color}
          onClick={() => {
            dispatch({ type: "color", id: channel.id, color: null });
            onClose();
          }}
          className="h-6 rounded-full px-2 text-xs text-cream/60 ring-1 ring-cream/25 hover:text-cream"
        >
          none
        </button>
        <ColorInput
          label="Pick any bar color"
          value={channel.color}
          onCommit={(color) => {
            dispatch({ type: "color", id: channel.id, color });
            onClose();
          }}
        />
      </div>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          dispatch({ type: "favorite", id: channel.id });
          onClose();
        }}
      >
        {channel.favorite ? "★ Remove from favorites" : "☆ Add to favorites"}
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onEdit();
          onClose();
        }}
      >
        Edit station…
      </button>
      <button
        type="button"
        role="menuitem"
        className={cn(item, "text-accent")}
        onClick={() => {
          // Second click removes. Undo in Edit stations (or Ctrl+Z) brings it back.
          if (!armed) return setArmed(true);
          dispatch({ type: "delete", id: channel.id });
          onClose();
        }}
      >
        {armed ? `Click again to remove ${channel.name}` : "Remove station…"}
      </button>
    </div>
  );
}
