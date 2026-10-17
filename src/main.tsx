import "./styles.css";
import { useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { isRemote } from "@/lib/remote";
import { loadDiskLibrary } from "@/lib/library/disk";
import { loadYoutubeLibrary } from "@/lib/library/youtube";
import { loadDurable } from "@/lib/durable";
import { applyFonts, loadFonts } from "@/lib/fonts";
import { applyTheme, loadTheme } from "@/lib/theme";

type ScanStatus = { phase: "idle" | "walking" | "probing"; done: number; total: number };

function Boot({ status }: { status: ScanStatus | null }) {
  const measuring = status?.phase === "probing" && status.total > 0;
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 text-cream">
      <p className="text-4xl font-semibold tracking-tight">VayaView</p>
      <p className="text-sm text-cream/60 tabular-nums">
        {measuring
          ? `Measuring new files, ${status.done} of ${status.total}. This happens once per file.`
          : "Reading your library…"}
      </p>
      {measuring ? (
        <div className="h-1 w-72 overflow-hidden rounded-full bg-cream/15">
          <div className="h-full bg-accent" style={{ width: `${(status.done / status.total) * 100}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** A phone that has not been paired yet: ask for the PIN shown on the PC. */
function Pair() {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pin = (event.currentTarget.elements.namedItem("pin") as HTMLInputElement).value.trim();
    const response = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
    if (response.ok) window.location.reload();
    else setError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "That did not work.");
  }
  return (
    <form onSubmit={submit} className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center text-cream">
      <p className="text-3xl font-semibold tracking-tight">VayaView</p>
      <p className="text-sm text-cream/60">Enter the PIN shown on your PC under Phone.</p>
      <input
        name="pin"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus
        className="w-48 rounded-lg bg-bezel px-4 py-3 text-center text-2xl tracking-[0.4em] text-cream tabular-nums outline-none focus:outline-2 focus:outline-accent"
      />
      <button type="submit" className="rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-room">
        Connect
      </button>
      {error ? <p className="text-sm text-accent">{error}</p> : null}
    </form>
  );
}

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  if (isRemote) {
    const check = await fetch("/api/store").catch(() => null);
    if (check?.status === 401) return root.render(<Pair />);
  }
  // Saved settings come from files on disk, so read them before anything uses them.
  await loadDurable();
  applyTheme(loadTheme());
  void applyFonts(loadFonts(), false);
  root.render(<Boot status={null} />);
  const poll = window.setInterval(() => {
    fetch("/api/status")
      .then((response) => response.json() as Promise<ScanStatus>)
      .then((status) => root.render(<Boot status={status} />))
      .catch(() => {});
  }, 700);
  // The library must be in place before the app modules build their lookups.
  await loadDiskLibrary();
  // The YouTube videos stations use join the catalogue after the disk's, before anything reads it.
  await loadYoutubeLibrary();
  window.clearInterval(poll);
  const { ParlorApp } = await import("./components/parlor/parlor-app");
  root.render(<ParlorApp />);
}

void boot();
