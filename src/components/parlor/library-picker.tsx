import { useState } from "react";
import { CATALOG } from "@/lib/library/catalog";
import { searchLibrary } from "@/lib/library/match";
import type { Film } from "@/lib/library/types";
import { cn } from "@/lib/cn";

type PickerProps = {
  /** Already in the station. Shown as added, never added twice. */
  exclude?: ReadonlySet<string>;
  /** "Add" or "Make a station of". */
  verb: string;
  onPick: (ids: string[], label: string) => void;
  placeholder: string;
};

type Group = { show: string; seasons: Map<string, Film[]> };

function seasonLabel(film: Film): string {
  if (film.absolute) return "Episodes";
  if (film.season == null || film.episode == null || film.season === 0 || film.episode === 0) return "Specials";
  return `Season ${film.season}`;
}

const chip = "rounded-md px-2 py-1 text-xs";

/**
 * Search the library and take what you want: one film, every match, a whole
 * show, or a single season of it.
 */
export function LibraryPicker({ exclude, verb, onPick, placeholder }: PickerProps) {
  const [query, setQuery] = useState("");
  const hits = query.trim() ? searchLibrary(CATALOG, query).map((hit) => hit.entry) : [];
  const fresh = (films: Film[]) => films.filter((film) => !exclude?.has(film.id)).map((film) => film.id);

  const shows = new Map<string, Group>();
  const films: Film[] = [];
  for (const film of hits) {
    if (!film.genres.includes("TV") || !film.collection) {
      films.push(film);
      continue;
    }
    const group = shows.get(film.collection) ?? { show: film.collection, seasons: new Map() };
    const label = seasonLabel(film);
    group.seasons.set(label, [...(group.seasons.get(label) ?? []), film]);
    shows.set(film.collection, group);
  }

  function take(list: Film[], label: string) {
    const ids = fresh(list);
    if (ids.length > 0) onPick(ids, label);
  }

  function button(list: Film[], text: string, label: string) {
    const left = fresh(list).length;
    return (
      <button
        type="button"
        disabled={left === 0}
        onClick={() => take(list, label)}
        className={cn(chip, left === 0 ? "bg-cream/5 text-cream/35" : "bg-cream/10 text-cream hover:bg-accent hover:text-room")}
      >
        {left === 0 ? `${text} ✓` : `${text} · ${list.length}`}
      </button>
    );
  }

  return (
    <div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-lg border border-cream/15 bg-room px-3 py-2 text-sm text-cream outline-none focus-visible:outline-2 focus-visible:outline-accent"
      />
      {query.trim() && hits.length === 0 ? <p className="mt-2 text-xs text-cream/50">Nothing in your library matches.</p> : null}

      <ul className="mt-2 space-y-2">
        {[...shows.values()].map((group) => {
          const all = [...group.seasons.values()].flat();
          return (
            <li key={group.show} className="rounded-lg bg-screen p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto text-sm">{group.show}</span>
                {button(all, `${verb} whole show`, group.show)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[...group.seasons.entries()]
                  .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                  .map(([label, list]) => (
                    <span key={label}>{button(list, label, `${group.show} ${label}`)}</span>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>

      {films.length > 0 ? (
        <div className="mt-2 rounded-lg bg-screen p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm">
              {films.length} {films.length === 1 ? "film" : "films"}
            </span>
            {films.length > 1 ? button(films, `${verb} all`, query.trim()) : null}
          </div>
          <ul className="mt-1 max-h-48 overflow-y-auto">
            {films.slice(0, 100).map((film) => (
              <li key={film.id} className="flex items-center justify-between gap-2 border-b border-room py-1 text-sm">
                <span className="min-w-0 truncate">
                  {film.title} <span className="text-cream/45">{film.year || ""}</span>
                </span>
                {button([film], verb, film.title)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
