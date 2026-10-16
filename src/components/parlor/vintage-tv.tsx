import { useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "@/lib/cn";
import { libraryInfo } from "@/lib/library/catalog";

/**
 * Vintage TV: old cartoons, Saturday mornings and whole days of taped broadcasts from the
 * Internet Archive, downloaded into a folder that becomes part of the library. The start of a
 * bigger idea (a guide that looks like the era); for now it fills the library.
 */

type Result = { id: string; title: string; size: number; downloads: number; date: string; description: string; runtime: number };
type ItemFile = { name: string; size: number; length: number; format: string; best: boolean };
type Item = { id: string; title: string; files: ItemFile[] };
type Download = { id: string; identifier: string; file: string; title: string; dest: string; bytes: number; total: number; speed: number; state: "queued" | "downloading" | "paused" | "done" | "error"; error: string | null };
type Status = { folder: string; folders: string[]; items: Download[] };

/** Ready-made searches to start from. archive.org search syntax; each was tried and returns plenty. */
const STARTERS: { label: string; q: string }[] = [
  { label: "90s cartoons", q: "cartoons AND (1990s OR 90s OR year:[1990 TO 1999])" },
  { label: "Saturday mornings", q: '"saturday morning" AND (cartoons OR cartoon)' },
  { label: "Early 2000s kids TV", q: '("kids wb" OR "fox kids" OR "cartoon network" OR nickelodeon) AND year:[2000 TO 2004]' },
  { label: "Whole days off TV", q: '("recorded off tv" OR "vhs recording" OR "off air" OR "tv recording") AND (day OR broadcast OR marathon)' },
  { label: "Old commercials", q: "commercials AND (1980s OR 1990s OR 90s OR 80s)" },
];

const button = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-40";
const primary = "rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-room hover:opacity-90 disabled:opacity-40";

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function length(seconds: number): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
}

async function json<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Failed (${response.status})`);
  return data;
}

export function VintageTv({ onClose, onRescan, className }: { onClose: () => void; onRescan: () => void; className?: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, Item | "loading" | { error: string }>>({});
  const [status, setStatus] = useState<Status | null>(null);
  const seenDone = useRef<Set<string> | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);

  async function search(q: string) {
    setQuery(q);
    setSearching(true);
    setError(null);
    setOpen(null);
    try {
      setResults((await json<{ results: Result[] }>(`/api/vintage/search?q=${encodeURIComponent(q)}`)).results);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      setResults(null);
    }
    setSearching(false);
  }

  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (items[id] && items[id] !== "loading" && !("error" in (items[id] as object))) return;
    setItems((all) => ({ ...all, [id]: "loading" }));
    try {
      const item = await json<Item>(`/api/vintage/item/${encodeURIComponent(id)}`);
      setItems((all) => ({ ...all, [id]: item }));
    } catch (problem) {
      setItems((all) => ({ ...all, [id]: { error: problem instanceof Error ? problem.message : String(problem) } }));
    }
  }

  /** Every answer about downloads goes through here, so finished ones are noticed whoever asked. */
  function take(next: Status) {
    setStatus(next);
    const done = new Set(next.items.filter((item) => item.state === "done").map((item) => item.id));
    const fresh = seenDone.current != null && [...done].some((id) => !seenDone.current?.has(id));
    seenDone.current = done;
    // A new library folder needs the window reloaded: the stations are filed under the folder list,
    // and a rescan here would file this window's stations under the new list. A new file in a folder
    // the window already knows only needs a rescan.
    if (next.folders.join("|") !== libraryInfo.folders.join("|")) setReloadNeeded(true);
    else if (fresh) window.setTimeout(onRescan, 1500);
  }

  async function act(url: string, body: unknown = {}) {
    try {
      take(await json<Status>(url, body));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }

  // Progress comes from the app's own counters: once a second while something is moving, otherwise now and then.
  const busy = status?.items.some((item) => item.state === "downloading" || item.state === "queued") ?? false;
  useEffect(() => {
    let stopped = false;
    const poll = () =>
      json<Status>("/api/vintage/downloads")
        .then((next) => !stopped && take(next))
        .catch(() => {});
    void poll();
    const timer = window.setInterval(poll, busy ? 1000 : 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [busy]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim()) void search(query.trim());
  }

  const downloading = new Set(status?.items.filter((item) => item.state !== "done").map((item) => `${item.identifier}/${item.file}`));

  return (
    <section aria-label="Vintage TV" className={cn("flex min-h-0 flex-col overflow-hidden rounded-screen bg-bezel text-cream", className)}>
      <header className="flex shrink-0 items-center gap-4 border-b border-screen px-4 py-2">
        <h2 className="text-lg">Vintage TV</h2>
        <p className="hidden min-w-0 truncate text-xs text-cream/45 lg:block">Old cartoons and taped broadcasts from the Internet Archive, into your library.</p>
        <button type="button" onClick={onClose} className={cn(button, "ml-auto")}>
          Back to settings
        </button>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[3fr_2fr]">
        <section className="min-w-0 rounded-xl bg-screen p-4">
          <form onSubmit={submit} className="flex gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Look for a show, a channel, a year…"
              aria-label="Search the Internet Archive"
              className="min-w-0 flex-1 rounded-md bg-room px-3 py-1.5 text-sm text-cream placeholder:text-cream/30 focus:outline-1 focus:outline-accent"
            />
            <button type="submit" className={primary} disabled={searching || !query.trim()}>
              {searching ? "Looking…" : "Search"}
            </button>
          </form>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {STARTERS.map((starter) => (
              <button key={starter.label} type="button" className={button} disabled={searching} onClick={() => void search(starter.q)}>
                {starter.label}
              </button>
            ))}
          </div>
          {error ? <p className="mt-2 text-xs text-accent">{error}</p> : null}
          {results && results.length === 0 ? <p className="mt-3 text-xs text-cream/50">Nothing under 5 GB matches. Try fewer words.</p> : null}
          {results && results.length > 0 ? <p className="mt-3 text-xs text-cream/40">{results.length} recordings under 5 GB, smallest first.</p> : null}

          <ul className="mt-1 space-y-1">
            {results?.map((result) => {
              const item = items[result.id];
              return (
                <li key={result.id} className="rounded-lg bg-room/60">
                  <button type="button" onClick={() => void toggle(result.id)} aria-expanded={open === result.id} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-cream/5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{result.title}</span>
                      {result.description ? <span className="block truncate text-xs text-cream/40">{result.description}</span> : null}
                    </span>
                    <span className="shrink-0 text-right text-xs text-cream/60 tabular-nums">
                      {size(result.size)}
                      <span className="block text-cream/40">{[length(result.runtime), result.date.slice(0, 4)].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                  {open === result.id ? (
                    <div className="border-t border-screen px-3 py-2">
                      {item === "loading" || !item ? (
                        <p className="text-xs text-cream/50">Listing files…</p>
                      ) : "error" in item ? (
                        <p className="text-xs text-accent">{item.error}</p>
                      ) : item.files.length === 0 ? (
                        <p className="text-xs text-cream/50">No video files under 5 GB in this one.</p>
                      ) : (
                        <ul className="space-y-1">
                          {item.files.map((file) => {
                            const queued = downloading.has(`${item.id}/${file.name}`);
                            return (
                              <li key={file.name} className="flex items-center gap-2 text-xs">
                                <span className="min-w-0 flex-1 truncate" title={file.name}>
                                  {file.best ? <span className="mr-1.5 rounded bg-accent/20 px-1.5 py-0.5 text-[0.65rem] font-semibold text-accent">Best</span> : null}
                                  {file.name}
                                </span>
                                <span className="shrink-0 text-cream/50 tabular-nums">{[length(file.length), size(file.size), file.format].filter(Boolean).join(" · ")}</span>
                                <button
                                  type="button"
                                  disabled={queued}
                                  className={file.best ? primary : button}
                                  onClick={() => void act("/api/vintage/download", { identifier: item.id, file: file.name, title: item.title, size: file.size })}
                                >
                                  {queued ? "Added" : "Download"}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="min-w-0 space-y-3 rounded-xl bg-screen p-4">
          <h3 className="text-sm font-semibold tracking-wide text-cream/80">Downloads</h3>
          {reloadNeeded ? (
            <div className="flex items-center gap-2 rounded-lg bg-accent/15 p-2 text-xs">
              <span className="flex-1">The downloads folder is now part of your library. Reload to see the recordings in the guide.</span>
              <button type="button" className={primary} onClick={() => window.location.reload()}>
                Reload now
              </button>
            </div>
          ) : null}
          {status && status.items.length === 0 ? <p className="text-xs text-cream/45">Nothing yet. Pick a recording and press Download.</p> : null}
          <ul className="space-y-2">
            {status?.items
              .slice()
              .reverse()
              .map((item) => {
                const share = item.total ? Math.min(1, item.bytes / item.total) : 0;
                return (
                  <li key={item.id} className="rounded-lg bg-room/60 p-2 text-xs">
                    <p className="truncate text-sm" title={item.dest}>
                      {item.title}
                    </p>
                    <p className="truncate text-cream/40">{item.file}</p>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-cream/10">
                      <div className={cn("h-full rounded-full", item.state === "error" ? "bg-cream/40" : "bg-accent")} style={{ width: `${(item.state === "done" ? 1 : share) * 100}%` }} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="mr-auto text-cream/60 tabular-nums">
                        {item.state === "done"
                          ? `Done · ${size(item.total)} · in the library`
                          : item.state === "error"
                            ? item.error
                            : `${item.state === "downloading" ? "Downloading" : item.state === "queued" ? "Waiting" : "Paused"} · ${size(item.bytes)}${item.total ? ` of ${size(item.total)}` : ""}${item.state === "downloading" && item.speed ? ` · ${size(item.speed)}/s` : ""}`}
                      </span>
                      {item.state === "downloading" || item.state === "queued" ? (
                        <button type="button" className={button} onClick={() => void act(`/api/vintage/downloads/${item.id}/pause`)}>
                          Pause
                        </button>
                      ) : null}
                      {item.state === "paused" || item.state === "error" ? (
                        <button type="button" className={button} onClick={() => void act(`/api/vintage/downloads/${item.id}/resume`)}>
                          Resume
                        </button>
                      ) : null}
                      {item.state !== "done" ? (
                        <button type="button" className={button} onClick={() => void act(`/api/vintage/downloads/${item.id}/cancel`)}>
                          Cancel
                        </button>
                      ) : (
                        <button type="button" className={button} title="Takes it off this list. The recording stays in your library." onClick={() => void act(`/api/vintage/downloads/${item.id}/remove`)}>
                          Clear
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
          </ul>

          <div className="border-t border-room pt-3">
            <p className="text-xs text-cream/70">Download folder</p>
            <p className="mt-1 text-xs break-all text-cream/45">{status?.folder ?? "…"}</p>
            <button type="button" className={cn(button, "mt-2")} onClick={() => void act("/api/vintage/folder", { pick: true })}>
              Choose another folder…
            </button>
            <p className="mt-1 text-[0.7rem] text-cream/35">Finished recordings join your library from here.</p>
          </div>
        </section>
      </div>
    </section>
  );
}
