import { useEffect, useRef, useState } from "react";
import { HexColorInput, HexColorPicker } from "react-colorful";

type ColorInputProps = {
  value: string | null | undefined;
  onCommit: (color: string) => void;
  label: string;
  /** Text on the button that opens the picker. */
  text?: string;
};

/**
 * Any colour at all. Drag around the field (or type a hex code) to try it, then
 * Apply. Nothing changes until Apply, so trying colours is never saved by accident.
 */
export function ColorInput({ value, onCommit, label, text = "Any color" }: ColorInputProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? "#ff4d3a");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setDraft(value ?? "#ff4d3a");
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  return (
    <div ref={boxRef} className="relative inline-flex" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs text-cream/60 ring-1 ring-cream/25 hover:text-cream"
      >
        <span className="size-3.5 rounded-full" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} />
        {text}
      </button>
      {open ? (
        <div className="absolute top-8 left-0 z-[95] w-56 rounded-xl border border-cream/10 bg-bezel p-3 shadow-2xl">
          <HexColorPicker color={draft} onChange={setDraft} style={{ width: "100%", height: 150 }} />
          <div className="mt-2 flex items-center gap-2">
            <span className="size-7 shrink-0 rounded-md ring-1 ring-cream/20" style={{ backgroundColor: draft }} />
            <HexColorInput
              color={draft}
              onChange={setDraft}
              prefixed
              aria-label="Hex colour code"
              className="w-full rounded-md bg-screen px-2 py-1 text-xs text-cream uppercase outline-none focus:outline-1 focus:outline-accent"
            />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="rounded-md px-2.5 py-1 text-xs text-cream/60 hover:text-cream" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-room hover:opacity-90"
              onClick={() => {
                onCommit(draft);
                setOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
