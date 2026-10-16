import { useState, type FormEvent } from "react";
import { CATALOG, diskMissingIds, isDiskLibrary, libraryInfo } from "@/lib/library/catalog";

/** Where the films live. Saving rescans and rebuilds the stations. */
export function LibraryBar() {
  const [value, setValue] = useState(libraryInfo.folders.join("; "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(libraryInfo.error);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const folders = value
      .split(";")
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folders }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Could not save");
      setBusy(false);
      return;
    }
    window.location.reload();
  }

  const status = !libraryInfo.ffprobe
    ? "ffprobe was not found, so files cannot be measured."
    : isDiskLibrary()
      ? `${CATALOG.length} files on the schedule${diskMissingIds.size > 0 ? ` · ${diskMissingIds.size} not on disk` : ""}`
      : libraryInfo.folders.length > 0
        ? "No video files found there. Showing the demo catalog."
        : "Demo catalog. Paste a folder of videos to air your own.";

  return (
    <form onSubmit={save} className="px-2 pb-1">
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Library folder, for example D:\Movies  (separate several with ;)"
          aria-label="Library folders"
          className="min-w-0 flex-1 rounded-md bg-screen px-3 py-1.5 text-xs text-cream placeholder:text-cream/30 focus:outline-1 focus:outline-accent"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-50"
        >
          {busy ? "Scanning…" : "Scan"}
        </button>
      </div>
      <p className={error ? "mt-1 text-xs text-accent" : "mt-1 text-xs text-cream/40"}>{error ?? status}</p>
    </form>
  );
}
