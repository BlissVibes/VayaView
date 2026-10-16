import { useState } from "react";
import { cn } from "@/lib/cn";
import type { Film } from "@/lib/library/types";
import { durable } from "@/lib/durable";

/** A show's real episode list, season → episode numbers, as TVmaze has it. */
type Listing = { found: boolean; name?: string; year?: string; seasons?: Record<string, number[]> };

const KEY = "parlor.episodes";
const IGNORE_KEY = "parlor.episodes.ignore";

function load<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(durable.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 6,7,8,10 → "6–8, 10" */
function ranges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let end = i;
    while (sorted[end + 1] === (sorted[end] ?? 0) + 1) end += 1;
    parts.push(end > i ? `${sorted[i]}–${sorted[end]}` : `${sorted[i]}`);
    i = end;
  }
  return parts.join(", ");
}

type Row = { label: string; have: number[]; missing: number[]; total: number | null };

/**
 * Only a season you have started can be missing anything. A season with none
 * of its episodes here is one you do not collect, and is left out entirely.
 */
function compare(films: Film[], listing: Listing | undefined): { rows: Row[]; skipped: string[]; unnumbered: number } {
  const have = new Map<number, number[]>();
  const running: number[] = [];
  let unnumbered = 0;
  for (const film of films) {
    // Episode 0 is a special, and episode lists do not number those.
    if (film.episode == null || film.episode === 0) unnumbered += 1;
    else if (film.absolute) running.push(film.episode);
    // Season 0 is specials. Episode lists do not number those, so they are not compared.
    else if (film.season != null && film.season > 0) have.set(film.season, [...(have.get(film.season) ?? []), film.episode]);
  }
  const real = listing?.found ? (listing.seasons ?? {}) : null;
  const seasons = real
    ? Object.entries(real)
        .map(([season, list]) => ({ season: Number(season), list }))
        .sort((a, b) => a.season - b.season)
    : [];
  const rows: Row[] = [];
  const skipped: string[] = [];

  if (running.length > 0) {
    if (!real) rows.push({ label: "Episodes", have: running, missing: [], total: null });
    // The running count is laid over the real seasons in order, so each season gets its own stretch of numbers.
    let start = 1;
    for (const { season, list } of seasons) {
      const end = start + list.length - 1;
      const mine = running.filter((n) => n >= start && n <= end);
      const span = Array.from({ length: list.length }, (_, i) => start + i);
      if (mine.length > 0) rows.push({ label: `Season ${season}`, have: mine, missing: span.filter((n) => !mine.includes(n)), total: list.length });
      else skipped.push(String(season));
      start = end + 1;
    }
  }

  if (have.size > 0) {
    const numbers = new Set([...have.keys(), ...seasons.map((item) => item.season)]);
    for (const season of [...numbers].sort((a, b) => a - b)) {
      const mine = have.get(season) ?? [];
      if (mine.length === 0) {
        skipped.push(String(season));
        continue;
      }
      const list = real?.[String(season)];
      // Without the real list, the only thing known to be missing is a gap before the last episode here.
      const expected = list ?? Array.from({ length: Math.max(...mine) }, (_, i) => i + 1);
      rows.push({ label: `Season ${season}`, have: mine, missing: expected.filter((n) => !mine.includes(n)), total: list ? list.length : null });
    }
  }
  return { rows, skipped, unnumbered };
}

/**
 * What a show's station is missing. Gaps are worked out from the files alone.
 * The rest of a season can only be known from a real episode list, fetched by
 * name when the button is pressed. Any season's gaps can be set aside.
 */
export function EpisodeCheck({ show, films }: { show: string; films: Film[] }) {
  const [listings, setListings] = useState(() => load<Record<string, Listing>>(KEY, {}));
  const [ignored, setIgnored] = useState(() => new Set(load<string[]>(IGNORE_KEY, [])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Doctor.Who.2005.S02E01" says which Doctor Who. Pass that year along so the right show is looked up.
  const words = show.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const year =
    films
      .map((film) => new RegExp(`${words.replace(/ /g, "[ ._-]+")}[ ._-]+\\(?((?:19|20)\\d{2})`).exec((film.fileName ?? "").toLowerCase())?.[1])
      .find(Boolean) ?? "";
  const cacheKey = year ? `${show}|${year}` : show;
  const listing = listings[cacheKey];
  const { rows, skipped, unnumbered } = compare(films, listing);
  const ignoreKey = (row: Row) => `${show}|${row.label}`;
  const missing = rows.reduce((sum, row) => sum + (ignored.has(ignoreKey(row)) ? 0 : row.missing.length), 0);

  async function check(refresh: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/episodes?show=${encodeURIComponent(show)}&year=${year}${refresh ? "&refresh=1" : ""}`);
      const body = (await response.json()) as Listing & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Lookup failed");
      const next = { ...listings, [cacheKey]: body };
      setListings(next);
      durable.setItem(KEY, JSON.stringify(next));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Lookup failed");
    }
    setBusy(false);
  }

  function toggleIgnore(row: Row) {
    const next = new Set(ignored);
    if (next.has(ignoreKey(row))) next.delete(ignoreKey(row));
    else next.add(ignoreKey(row));
    setIgnored(next);
    durable.setItem(IGNORE_KEY, JSON.stringify([...next]));
  }

  return (
    <div className="rounded-xl bg-screen p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          Episodes{" "}
          <span className={missing > 0 ? "text-accent" : "text-cream/60"}>
            {missing > 0 ? `· ${missing} missing` : listing?.found ? "· nothing missing" : "· no gaps found"}
          </span>
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => check(Boolean(listing))}
          className="rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-50"
        >
          {busy ? "Checking…" : listing ? "Check again" : "Check full seasons online"}
        </button>
      </div>

      <ul className="mt-2 space-y-1 text-xs tabular-nums">
        {rows.map((row) => {
          const off = ignored.has(ignoreKey(row));
          return (
            <li key={row.label} className="flex items-baseline gap-3">
              <span className="w-20 shrink-0 text-cream/70">{row.label}</span>
              <span className={cn("min-w-0 flex-1", off && "opacity-50")}>
                <span className="text-cream/60">
                  have {ranges(row.have)}
                  {row.total != null ? ` of ${row.total}` : ""}
                </span>
                {row.missing.length > 0 ? (
                  <span className={off ? "text-cream/60" : "text-accent"}>
                    {" "}
                    · missing {ranges(row.missing)}
                    {off ? " (ignored)" : ""}
                  </span>
                ) : null}
              </span>
              {row.missing.length > 0 ? (
                <button type="button" onClick={() => toggleIgnore(row)} className="shrink-0 text-cream/50 underline hover:text-cream">
                  {off ? "Count it" : "Ignore"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-xs text-cream/40">
        {error
          ? error
          : listing?.found
            ? `Compared with TVmaze's list for ${listing.name}${listing.year ? ` (${listing.year})` : ""}. Wrong show? Rename the station and check again.`
            : listing
              ? `TVmaze has no show called "${show}". Rename the station to the show's real title and check again.`
              : "Only gaps before the last episode you have are shown. The button looks the show up by name on TVmaze to find the rest of each season you have started."}
        {skipped.length > 0 ? ` Season${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not in your library, so ${skipped.length === 1 ? "it is" : "they are"} not counted.` : ""}
        {unnumbered > 0 ? ` ${unnumbered} special${unnumbered === 1 ? "" : "s"} or unnumbered file${unnumbered === 1 ? "" : "s"} not compared.` : ""}
      </p>
    </div>
  );
}
