import type { Film } from "./types.ts";

/**
 * Library search. Runs against tags already stored on each film.
 * It does not open files and it does not infer genre from a title.
 *
 * A franchise query matches the collection name, then every film in that
 * collection is included — even when the title itself doesn't contain the words
 * ("Age of Rust" belongs to "Iron Harvest").
 */

const STOP = new Set(["the", "a", "an", "of", "and", "or"]);

export type MatchKind = "title" | "collection" | "director" | "genre" | "keyword";

export type MatchReason = {
  kind: MatchKind;
  label: string;
};

export type SearchHit = {
  entry: Film;
  reasons: MatchReason[];
};

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function queryTokens(query: string): string[] {
  return normalize(query)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP.has(token));
}

function hasAllTokens(field: string, tokens: readonly string[]): boolean {
  const padded = ` ${normalize(field)} `;
  return tokens.every((token) => padded.includes(` ${token} `));
}

function dedupe(reasons: MatchReason[]): MatchReason[] {
  const seen = new Set<string>();
  const out: MatchReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.kind}:${reason.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out;
}

function score(hit: SearchHit, query: string): number {
  const kinds = new Set(hit.reasons.map((reason) => reason.kind));
  if (kinds.has("title") && normalize(hit.entry.title) === normalize(query)) return 0;
  if (kinds.has("collection")) return 1;
  if (kinds.has("title")) return 2;
  if (kinds.has("director")) return 3;
  if (kinds.has("keyword")) return 4;
  return 5;
}

export function searchLibrary(entries: readonly Film[], query: string): SearchHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const matchedCollections = new Set<string>();
  for (const entry of entries) {
    if (entry.collection && hasAllTokens(entry.collection, tokens)) {
      matchedCollections.add(entry.collection);
    }
  }

  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const reasons: MatchReason[] = [];
    if (entry.collection && matchedCollections.has(entry.collection)) {
      reasons.push({ kind: "collection", label: entry.collection });
    }
    if (hasAllTokens(entry.title, tokens)) {
      reasons.push({ kind: "title", label: entry.title });
    }
    if (hasAllTokens(entry.director, tokens)) {
      reasons.push({ kind: "director", label: entry.director });
    }
    for (const genre of entry.genres) {
      if (hasAllTokens(genre, tokens)) reasons.push({ kind: "genre", label: genre });
    }
    for (const keyword of entry.keywords) {
      if (hasAllTokens(keyword, tokens)) reasons.push({ kind: "keyword", label: keyword });
    }
    if (reasons.length === 0) continue;
    hits.push({ entry, reasons: dedupe(reasons) });
  }

  hits.sort((a, b) => {
    const diff = score(a, query) - score(b, query);
    if (diff !== 0) return diff;
    if (a.entry.year !== b.entry.year) return a.entry.year - b.entry.year;
    return a.entry.title.localeCompare(b.entry.title);
  });
  return hits;
}

export function searchNote(query: string, hits: readonly SearchHit[]): string | null {
  const tokens = queryTokens(query);
  if (hits.length === 0 || tokens.length === 0) return null;
  const byGenre = hits.some(
    (hit) =>
      hit.reasons.some((reason) => reason.kind === "genre") &&
      !hasAllTokens(hit.entry.title, tokens),
  );
  if (byGenre) {
    return "Some of these match a genre tag. The title never had to say the word.";
  }
  const byCollectionOnly = hits.some((hit) => hit.reasons.every((reason) => reason.kind === "collection"));
  if (byCollectionOnly) {
    return "Some titles do not contain your search. They are in the collection, so they still join.";
  }
  return null;
}
