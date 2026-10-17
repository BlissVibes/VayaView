import type { Channel, ChannelMode } from "../schedule/types.ts";
import type { Film } from "./types.ts";

/**
 * A station the library could support but does not have yet. Built from what is on disk and what
 * TMDB said about it: genres, franchises, directors, decades, shows. Nothing here is saved; the
 * user picks the ones they want, or takes a whole group at once.
 */
export type Suggestion = {
  /** Stable across scans, so a suggestion already taken (or hidden) can be told apart. */
  key: string;
  group: SuggestionGroup;
  name: string;
  mode: ChannelMode;
  mediaIds: string[];
  /** One line under the name: "14 films", "3 shows · 212 episodes". */
  note: string;
};

export type SuggestionGroup = "Starters" | "Shows" | "Franchises" | "Genres" | "Decades" | "Directors" | "Themes";

export const SUGGESTION_GROUPS: SuggestionGroup[] = ["Starters", "Shows", "Franchises", "Genres", "Decades", "Directors", "Themes"];

/** How many of a thing a station needs before it is worth suggesting. One film on a loop is not a channel. */
const LEAST = { starter: 2, show: 2, franchise: 2, genreFilms: 5, genreEpisodes: 12, genreShows: 2, decade: 4, director: 3, theme: 5, shorts: 4 };

/** The same films or episodes, in any order. */
export const lineupKey = (ids: readonly string[]) => ids.slice().sort().join();

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Genres TMDB uses as broad buckets that make a dull station on their own. */
const DULL_GENRES = new Set(["Movie", "TV", "Short", "Foreign", "TV Movie"]);

/** Keywords worth a station of their own when enough films share them. Lower-cased. */
const THEME_WORDS = new Set([
  "christmas", "halloween", "heist", "time travel", "zombie", "vampire", "werewolf", "haunted house", "slasher", "found footage", "coming of age",
  "road trip", "space", "alien", "robot", "artificial intelligence", "dystopia", "post-apocalyptic", "superhero", "martial arts", "samurai", "pirate",
  "western", "noir", "film noir", "musical", "biography", "based on true story", "based on novel or book", "based on comic", "video game", "sports",
  "boxing", "baseball", "football", "high school", "summer camp", "wedding", "spy", "assassin", "serial killer", "courtroom", "prison", "war",
  "world war ii", "vietnam war", "cold war", "submarine", "shark", "dinosaur", "giant monster", "kaiju", "ghost", "demon", "witch", "magic",
  "dragon", "sword and sorcery", "fairy tale", "animation", "anime", "stop motion", "silent film", "black and white", "cult film", "parody", "satire",
  "mockumentary", "buddy comedy", "romantic comedy", "monster", "survival", "disaster", "volcano", "tornado", "hurricane", "epidemic", "virus",
  "detective", "private detective", "police", "mafia", "gangster", "bank robbery", "con artist", "revenge", "kidnapping", "hostage", "chase",
  "car race", "racing", "motorcycle", "train", "airplane", "ocean", "island", "jungle", "desert", "arctic", "mountain", "cave",
]);

function byMap(items: readonly Film[], pick: (film: Film) => string[] | string | null | undefined): Map<string, Film[]> {
  const map = new Map<string, Film[]>();
  for (const film of items) {
    const value = pick(film);
    const keys = value == null ? [] : Array.isArray(value) ? value : [value];
    for (const key of keys) {
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), film]);
    }
  }
  return map;
}

/** Films in the order a franchise station should air them: by year, then title. */
const byYear = (films: Film[]) => films.slice().sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));

/**
 * Every station the library could support that is not already in the lineup. A station already
 * there with the same films, or the same name, is left out, whoever made it.
 */
export function suggestStations(catalog: readonly Film[], existing: readonly Channel[]): Suggestion[] {
  const taken = new Set(existing.map((channel) => lineupKey(channel.mediaIds)));
  const names = new Set(existing.map((channel) => channel.name.trim().toLowerCase()));
  const out: Suggestion[] = [];
  const add = (group: SuggestionGroup, key: string, name: string, mode: ChannelMode, films: Film[], least: number, note?: string) => {
    if (films.length < least) return;
    const mediaIds = films.map((film) => film.id);
    if (taken.has(lineupKey(mediaIds)) || names.has(name.toLowerCase())) return;
    out.push({ key: `${slug(group)}-${slug(key)}`, group, name, mode, mediaIds, note: note ?? plural(films.length, "film") });
  };

  // YouTube videos (genres[0] "YouTube") are never counted as films, shows or shorts: they get their own stations.
  const local = catalog.filter((film) => !film.youtubeId);
  const movies = local.filter((film) => film.genres[0] === "Movie");
  const episodes = local.filter((film) => film.genres[0] === "TV");
  const shorts = local.filter((film) => film.genres[0] === "Short");
  const ids = (films: readonly Film[]) => films.map((film) => film.id);

  // Starters: the whole library cut in two, plus the odds and ends.
  const shows = byMap(episodes, (film) => film.collection);
  add("Starters", "movies", "Movies", "shuffle", movies, LEAST.starter);
  add("Starters", "tv", "TV Mix", "shuffle", episodes, LEAST.starter, `${plural(shows.size, "show")} · ${plural(episodes.length, "episode")}`);
  add("Starters", "shorts", "Shorts & Extras", "shuffle", shorts, LEAST.shorts, plural(shorts.length, "short"));

  // Shows: each one in order, the way it aired.
  for (const name of [...shows.keys()].sort((a, b) => a.localeCompare(b))) {
    const list = shows.get(name) ?? [];
    add("Shows", name, name, "loop", list, LEAST.show, plural(list.length, "episode"));
  }

  // Franchises: a TMDB collection, in release order.
  const sets = byMap(movies, (film) => film.collection);
  for (const name of [...sets.keys()].sort((a, b) => a.localeCompare(b))) {
    const clean = name.replace(/\s+Collection$/i, "");
    add("Franchises", clean, clean, "loop", byYear(sets.get(name) ?? []), LEAST.franchise);
  }

  // Genres: films by genre, biggest first; then the same for television, counted in shows as well as episodes.
  const filmGenres = byMap(movies, (film) => film.genres.slice(1).filter((genre) => !DULL_GENRES.has(genre)));
  for (const [genre, list] of [...filmGenres].sort((a, b) => b[1].length - a[1].length)) add("Genres", `${genre} movies`, `${genre} Movies`, "shuffle", list, LEAST.genreFilms);
  const tvGenres = byMap(episodes, (film) => film.genres.slice(1).filter((genre) => !DULL_GENRES.has(genre)));
  for (const [genre, list] of [...tvGenres].sort((a, b) => b[1].length - a[1].length)) {
    const showCount = new Set(list.map((film) => film.collection)).size;
    if (showCount < LEAST.genreShows) continue;
    add("Genres", `${genre} tv`, `${genre} TV`, "shuffle", list, LEAST.genreEpisodes, `${plural(showCount, "show")} · ${plural(list.length, "episode")}`);
  }

  // Decades: films by the decade they came out.
  const decades = byMap(movies, (film) => (film.year >= 1900 ? String(Math.floor(film.year / 10) * 10) : null));
  for (const decade of [...decades.keys()].sort()) add("Decades", decade, `${decade}s Movies`, "shuffle", decades.get(decade) ?? [], LEAST.decade);

  // Directors with a body of work on the disk.
  const directors = byMap(movies, (film) => film.director.trim() || null);
  for (const [name, list] of [...directors].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) add("Directors", name, name, "shuffle", byYear(list), LEAST.director);

  // Themes: TMDB keywords that make a good night of television.
  const themes = byMap(movies, (film) => film.keywords.map((word) => word.toLowerCase()).filter((word) => THEME_WORDS.has(word)));
  for (const [word, list] of [...themes].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    const name = word.replace(/\b\w/g, (letter) => letter.toUpperCase());
    add("Themes", word, name, "shuffle", list, LEAST.theme);
  }

  // Nothing at all yet (a fresh library before TMDB has run) still gets the two halves, if they exist.
  void ids;
  return out;
}

/**
 * Free stations to come: whole channels streamed from the Internet Archive (archive.org), no
 * download needed. Not built yet. For now each one is a Vintage TV search that fills the library
 * with the same material.
 */
export type FreeChannel = { key: string; name: string; blurb: string; q: string };

export const FREE_CHANNELS: FreeChannel[] = [
  { key: "classic-cartoons", name: "Classic Cartoons", blurb: "Fleischer, Famous Studios, Popeye, Betty Boop: public-domain animation from the 1930s and 40s.", q: "collection:classic_cartoons AND mediatype:movies" },
  { key: "saturday-morning", name: "Saturday Morning", blurb: "Taped Saturday-morning blocks, bumpers and all.", q: '"saturday morning" AND (cartoons OR cartoon)' },
  { key: "feature-films", name: "Public Domain Movies", blurb: "Whole features whose copyright has lapsed: Night of the Living Dead, His Girl Friday, Charade.", q: "collection:feature_films AND mediatype:movies" },
  { key: "film-noir", name: "Film Noir", blurb: "Detectives, dames and rain on the window, 1940 to 1958.", q: "collection:Film_Noir AND mediatype:movies" },
  { key: "sci-fi-horror", name: "Late Night Creature Features", blurb: "B-movie science fiction and horror, the drive-in way.", q: "collection:SciFi_Horror AND mediatype:movies" },
  { key: "comedy-shorts", name: "Comedy Shorts", blurb: "Chaplin, Keaton, Laurel and Hardy and the two-reelers.", q: "collection:comedy_films AND mediatype:movies" },
  { key: "prelinger", name: "Prelinger Archives", blurb: "Educational, industrial and advertising films from mid-century America.", q: "collection:prelinger AND mediatype:movies" },
  { key: "commercials", name: "Old Commercials", blurb: "Ad breaks from the 1950s to the 1990s, to run between programmes.", q: "commercials AND (1950s OR 1960s OR 1970s OR 1980s OR 1990s)" },
  { key: "newsreels", name: "Newsreels", blurb: "Universal Newsreel and friends: the week's news as the cinema showed it.", q: "collection:universal_newsreels AND mediatype:movies" },
  { key: "westerns", name: "Westerns", blurb: "Public-domain cowboys: Hopalong Cassidy, Roy Rogers, the serials.", q: "(western OR westerns) AND collection:feature_films AND mediatype:movies" },
];
