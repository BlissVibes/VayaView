import { useEffect, useRef, useState, type FormEvent } from "react";
import { libraryInfo } from "@/lib/library/catalog";

type TmdbStatus = { hasToken: boolean; builtIn?: boolean; running: boolean; done: number; total: number; error: string | null; matched: number; unmatched: number };

const button = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-40";

/**
 * Where the TMDB token goes in. It is checked with TMDB, kept in a file on this PC,
 * and never shown again or sent to a phone. Lookups then run once per title.
 */
export function TmdbBox({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [status, setStatus] = useState<TmdbStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wasRunning = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Opened from a button at the bottom of a scrolling panel: bring it into view once.
  useEffect(() => {
    boxRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  async function load() {
    try {
      const next = (await (await fetch("/api/tmdb")).json()) as TmdbStatus;
      setStatus(next);
      // A run just finished: read the library again so the new genres show up.
      if (wasRunning.current && !next.running) void onRefresh();
      wasRunning.current = next.running;
    } catch {
      setStatus(null);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 1500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll for the life of the box
  }, []);

  async function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("token") as HTMLInputElement;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/tmdb/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: input.value }) });
    const body = (await response.json()) as TmdbStatus & { error?: string };
    if (!response.ok) setError(body.error ?? "TMDB did not accept that token.");
    else {
      input.value = "";
      setStatus(body);
      await lookUp(false);
    }
    setBusy(false);
  }

  async function lookUp(again: boolean) {
    await fetch(`/api/tmdb/lookup${again ? "?again=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: libraryInfo.metaItems }),
    });
    wasRunning.current = true;
    void load();
  }

  return (
    <div ref={boxRef} className="mt-3 space-y-2 px-1 pb-1 text-xs">
      <p className="text-cream/70">Movie and show info from TMDB (genres, franchises, directors)</p>
      {status?.hasToken ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-cream/60">
            {status.running
              ? `Looking up ${status.done} of ${status.total}…`
              : `${status.builtIn ? "Built in, no account needed" : "Token saved"} · ${status.matched} titles matched${status.unmatched ? `, ${status.unmatched} not found` : ""}`}
          </span>
          <button type="button" className={button} disabled={busy || status.running} onClick={() => lookUp(false)}>
            Look up new titles
          </button>
          <button type="button" className={button} disabled={busy || status.running} onClick={() => lookUp(true)}>
            Redo all
          </button>
        </div>
      ) : null}
      <form onSubmit={saveToken} className="flex items-center gap-2">
        <input
          name="token"
          type="password"
          autoComplete="off"
          placeholder={status?.builtIn ? "Optional: your own TMDB token, to use instead of the built-in one" : status?.hasToken ? "Paste a new token to replace the saved one" : "Paste your TMDB API Read Access Token"}
          aria-label="TMDB API Read Access Token"
          className="min-w-0 flex-1 rounded-md bg-screen px-3 py-1.5 text-xs text-cream placeholder:text-cream/30 focus:outline-1 focus:outline-accent"
        />
        <button type="submit" className={button} disabled={busy}>
          {busy ? "Checking…" : "Save"}
        </button>
      </form>
      {error || status?.error ? <p className="text-accent">{error ?? status?.error}</p> : null}
    </div>
  );
}
