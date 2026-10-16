import type { Film } from "./types.ts";

const m = (minutes: number) => minutes * 60_000;

function film(input: Omit<Film, "filePath" | "metadataId" | "fileName" | "direct">): Film {
  return { ...input, filePath: null, metadataId: null };
}

/**
 * Preview library. Original titles only.
 * Tags stand in for what a metadata lookup would attach on a real disk.
 * `Age of Rust` and `Workshop Blueprints` are in the Iron Harvest collection
 * without those words in the title, on purpose.
 */
export const CATALOG: Film[] = [
  film({
    id: "iron-harvest",
    title: "Iron Harvest",
    year: 2007,
    durationMs: m(138),
    director: "Cole Brenner",
    genres: ["Action"],
    keywords: ["machines"],
    collection: "Iron Harvest",
    synopsis: "Farmers wake a line of buried harvesters and lose the valley by dusk.",
    scenes: ["The field splits open", "First machine stands up", "The valley goes dark"],
  }),
  film({
    id: "broken-latitude",
    title: "Iron Harvest: Broken Latitude",
    year: 2009,
    durationMs: m(151),
    director: "Cole Brenner",
    genres: ["Action"],
    keywords: ["machines"],
    collection: "Iron Harvest",
    synopsis: "The fleet crosses an ice line that was never on the maps.",
    scenes: ["Convoy on the pack ice", "A harvester falls through", "Signal from the south"],
  }),
  film({
    id: "night-shift",
    title: "Iron Harvest: Night Shift",
    year: 2011,
    durationMs: m(146),
    director: "Cole Brenner",
    genres: ["Action"],
    keywords: ["machines"],
    collection: "Iron Harvest",
    synopsis: "A city leases the machines after dark and pretends not to hear them.",
    scenes: ["Yard lights at midnight", "Shift change underground", "Dawn over the stacks"],
  }),
  film({
    id: "age-of-rust",
    title: "Age of Rust",
    year: 2014,
    durationMs: m(164),
    director: "Mina Cho",
    genres: ["Action"],
    keywords: ["machines"],
    collection: "Iron Harvest",
    synopsis: "One mechanic keeps a single harvester alive after the fleet is scrapped.",
    scenes: ["The yard of dead machines", "She finds a living engine", "They leave the coast road"],
  }),
  film({
    id: "last-signal",
    title: "Iron Harvest: Last Signal",
    year: 2017,
    durationMs: m(155),
    director: "Mina Cho",
    genres: ["Action"],
    keywords: ["machines"],
    collection: "Iron Harvest",
    synopsis: "The last pilot answers a coordinates ping nobody admits sending.",
    scenes: ["An empty hangar", "The ping repeats", "One machine answers"],
  }),
  film({
    id: "blueprints",
    title: "Workshop Blueprints",
    year: 2019,
    durationMs: m(98),
    director: "Mina Cho",
    genres: ["Action"],
    keywords: ["machines"],
    collection: "Iron Harvest",
    synopsis: "A restored lecture on how the first harvester was built. The file is not on this computer.",
    scenes: ["Chalk on a shop wall", "The first frame", "The reel runs out"],
  }),
  film({
    id: "lantern-night",
    title: "Lantern Night",
    year: 2019,
    durationMs: m(147),
    director: "Asta Pell",
    genres: ["Horror", "Drama"],
    keywords: ["folk horror", "ritual", "daylight"],
    collection: null,
    synopsis: "A harbor town lights the water once a year, and the tide does not go out.",
    scenes: ["Paper lanterns on the quay", "The tide stays high", "Morning that will not start"],
  }),
  film({
    id: "cold-water",
    title: "Cold Water Gospel",
    year: 1978,
    durationMs: m(91),
    director: "Ned Carrow",
    genres: ["Horror"],
    keywords: ["folk horror"],
    collection: null,
    synopsis: "A choir records an album on a frozen lake and starts harmonizing with something under the ice.",
    scenes: ["Mics on the ice", "A low note answers", "The take will not end"],
  }),
  film({
    id: "cinder-stair",
    title: "The Cinder Stair",
    year: 2016,
    durationMs: m(103),
    director: "Ned Carrow",
    genres: ["Horror", "Thriller"],
    keywords: [],
    collection: null,
    synopsis: "A hotel's service stair keeps adding landings the staff did not build.",
    scenes: ["Basement landing", "A floor that was not there", "The door at the top"],
  }),
  film({
    id: "room-tone",
    title: "Room Tone",
    year: 2004,
    durationMs: m(86),
    director: "Ivy Quell",
    genres: ["Horror"],
    keywords: [],
    collection: null,
    synopsis: "A recordist captures sixty seconds of silence and finds a voice living in it.",
    scenes: ["Empty apartment", "The meter moves", "She plays it back"],
  }),
  film({
    id: "milk-glass",
    title: "Milk Glass",
    year: 1999,
    durationMs: m(95),
    director: "Ivy Quell",
    genres: ["Horror", "Mystery"],
    keywords: [],
    collection: null,
    synopsis: "A family inherits a greenhouse that only grows after dark. The file is not on this computer.",
    scenes: ["Glass at dusk", "Leaves overnight", "The door latches itself"],
  }),
  film({
    id: "june-roof",
    title: "June on the Roof",
    year: 2013,
    durationMs: m(106),
    director: "Lena Voss",
    genres: ["Drama"],
    keywords: ["coming of age"],
    collection: null,
    synopsis: "A teenager spends one summer running the elevator in a hotel that is closing.",
    scenes: ["First shift in the cage", "A guest who stays", "The roof at 2 a.m."],
  }),
  film({
    id: "second-bell",
    title: "Second Bell",
    year: 2001,
    durationMs: m(98),
    director: "Harun Ellis",
    genres: ["Drama"],
    keywords: ["coming of age"],
    collection: null,
    synopsis: "Two cousins share a paper route the year the mill closes.",
    scenes: ["Bundles before dawn", "The mill whistle stops", "Last street on the route"],
  }),
  film({
    id: "longest-august",
    title: "The Longest August",
    year: 2018,
    durationMs: m(114),
    director: "Lena Voss",
    genres: ["Drama"],
    keywords: ["coming of age"],
    collection: null,
    synopsis: "A dropout drives a county library van and starts reading the holds out loud.",
    scenes: ["Van at the gravel lot", "A hold for someone who moved", "She keeps the route"],
  }),
  film({
    id: "paper-coast",
    title: "Paper Coast",
    year: 1994,
    durationMs: m(93),
    director: "Harun Ellis",
    genres: ["Drama"],
    keywords: ["coming of age"],
    collection: null,
    synopsis: "A kid maps the beach behind the house as it erodes, one tide at a time.",
    scenes: ["Pencil map on the table", "The stairs lose a step", "A new line on the chart"],
  }),
  film({
    id: "orbit-desk",
    title: "Orbit Desk",
    year: 1986,
    durationMs: m(121),
    director: "S. Ren",
    genres: ["Science Fiction"],
    keywords: ["sci-fi"],
    collection: null,
    synopsis: "A night clerk on a station answers complaints from people who cannot leave.",
    scenes: ["The desk lamp", "A complaint from ring three", "Shift end that does not come"],
  }),
  film({
    id: "quiet-ships",
    title: "Quiet Ships",
    year: 2015,
    durationMs: m(132),
    director: "S. Ren",
    genres: ["Science Fiction", "Drama"],
    keywords: ["sci-fi"],
    collection: null,
    synopsis: "Freight crews stop speaking between ports, and the ships keep the schedule anyway.",
    scenes: ["Departure silent", "A note instead of a call", "Docking on time"],
  }),
  film({
    id: "manual-for-leaving",
    title: "A Manual for Leaving",
    year: 2021,
    durationMs: m(109),
    director: "Lena Voss",
    genres: ["Science Fiction"],
    keywords: ["sci-fi", "coming of age"],
    collection: null,
    synopsis: "A young navigator quits a generation ship and has to learn weather.",
    scenes: ["She turns in the badge", "First rain", "A map with no rings"],
  }),
  film({
    id: "station-hymn",
    title: "Station Hymn",
    year: 1972,
    durationMs: m(100),
    director: "S. Ren",
    genres: ["Science Fiction"],
    keywords: ["sci-fi"],
    collection: null,
    synopsis: "The station computer begins broadcasting a hymn, and the crew starts singing along.",
    scenes: ["A tone in the duct", "Words on the printer", "The whole ring joins"],
  }),
  film({
    id: "winter-index",
    title: "Winter Index",
    year: 2009,
    durationMs: m(118),
    director: "Lena Voss",
    genres: ["Drama"],
    keywords: ["archive"],
    collection: null,
    synopsis: "An archivist indexes a dead poet and starts living in the margins of the cards.",
    scenes: ["Drawer of index cards", "A line she did not write", "The reading room at close"],
  }),
];

export const catalogById = new Map<string, Film>(CATALOG.map((film) => [film.id, film]));

/** Files the last scan could not find. Their slots stay on the schedule. */
export const diskMissingIds = new Set<string>();

export const libraryInfo = {
  folders: [] as string[],
  ffprobe: true,
  error: null as string | null,
  /** Every film and show as TMDB will be asked about it. Filled when the library loads. */
  metaItems: [] as { key: string; kind: "movie" | "tv"; title: string; year: number | string }[],
};

let disk = false;

export function isDiskLibrary(): boolean {
  return disk;
}

/**
 * Swap the preview catalog for the user's own files. Called once at boot,
 * before anything reads CATALOG. See src/main.tsx.
 */
export function setDiskLibrary(films: Film[], missingIds: string[]): void {
  disk = true;
  CATALOG.length = 0;
  CATALOG.push(...films);
  catalogById.clear();
  for (const entry of films) catalogById.set(entry.id, entry);
  diskMissingIds.clear();
  for (const id of missingIds) diskMissingIds.add(id);
}

export function sceneAt(entry: Film, offsetMs: number): string {
  if (entry.scenes.length === 0 || entry.durationMs <= 0) return "";
  const ratio = Math.min(0.999, Math.max(0, offsetMs / entry.durationMs));
  const index = Math.floor(ratio * entry.scenes.length);
  return entry.scenes[index] ?? "";
}
