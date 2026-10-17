import { searchLibrary } from "./match.ts";
import { CATALOG, isDiskLibrary } from "./catalog.ts";
import { makeCallSign } from "./naming.ts";
import type { Channel } from "../schedule/types.ts";
import type { ParlorState } from "./state.ts";

/** Joins mid Age of Rust on 13 Oct 2026 — a title that does not say "Iron Harvest". */
export const FACTORY_ANCHOR = Date.UTC(2026, 9, 13, 11, 5, 0);

function smartChannel(args: {
  id: string;
  number: number;
  name: string;
  callSign: string;
  mode: Channel["mode"];
  query: string;
}): Channel {
  const hits = searchLibrary(CATALOG, args.query);
  return {
    id: args.id,
    number: args.number,
    name: args.name,
    callSign: args.callSign,
    mode: args.mode,
    shuffleSeed: args.id,
    anchorMs: FACTORY_ANCHOR,
    mediaIds: hits.map((hit) => hit.entry.id),
    query: args.query,
  };
}

/** Disk stations have been on the air since New Year, so the first tune joins mid-film. */
export const DISK_ANCHOR = Date.UTC(2026, 0, 1);

const AUTO = "ch-auto-";

/**
 * Stations built from what is on disk: all films, all television, one per
 * decade, then one per show. Shows loop in episode order. The rest shuffle.
 */
function createDiskState(): ParlorState {
  const channels: Channel[] = [];
  // A station needs at least two things to air. One file on a loop is not a channel;
  // it still turns up on Movies or TV Mix.
  const add = (key: string, name: string, mode: Channel["mode"], mediaIds: string[], least = 2) => {
    if (mediaIds.length < least) return;
    const id = `${AUTO}${key}`;
    channels.push({
      id,
      number: channels.length + 2,
      name,
      callSign: makeCallSign(
        name,
        channels.map((channel) => channel.callSign),
      ),
      mode,
      shuffleSeed: id,
      anchorMs: DISK_ANCHOR,
      mediaIds,
      query: null,
    });
  };
  const ids = (films: typeof CATALOG) => films.map((entry) => entry.id);

  const movies = CATALOG.filter((entry) => entry.genres.includes("Movie"));
  const episodes = CATALOG.filter((entry) => entry.genres.includes("TV"));
  add("movies", "Movies", "shuffle", ids(movies));
  add("tv", "TV Mix", "shuffle", ids(episodes));

  const decades = new Map<number, string[]>();
  for (const entry of movies) {
    if (entry.year < 1900) continue;
    const decade = Math.floor(entry.year / 10) * 10;
    decades.set(decade, [...(decades.get(decade) ?? []), entry.id]);
  }
  for (const decade of [...decades.keys()].sort()) {
    const list = decades.get(decade) ?? [];
    if (list.length >= 4) add(`decade-${decade}`, `${decade}s Movies`, "shuffle", list);
  }

  const shows = new Map<string, string[]>();
  for (const entry of episodes) {
    if (!entry.collection) continue;
    shows.set(entry.collection, [...(shows.get(entry.collection) ?? []), entry.id]);
  }
  for (const name of [...shows.keys()].sort((a, b) => a.localeCompare(b))) {
    add(`show-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name, "loop", shows.get(name) ?? []);
  }

  const shorts = CATALOG.filter((entry) => entry.genres.includes("Short"));
  if (shorts.length >= 4) add("shorts", "Shorts & Extras", "shuffle", ids(shorts));

  if (channels.length === 0) add("all", "Everything", "shuffle", ids(CATALOG), 1);
  return { channels, missingIds: [], tunedId: channels[0]?.id ?? "", lastId: null, powered: true };
}

/**
 * A saved state meets today's disk. Built-in stations pick up new files and
 * new shows, and keep the number, name, call sign and mode the user gave them.
 * Stations the user made by hand are left alone.
 */
export function refreshDiskState(saved: ParlorState): ParlorState {
  if (!isDiskLibrary()) return saved;
  const fresh = createDiskState().channels;
  const old = new Map(saved.channels.map((channel) => [channel.id, channel]));
  const hidden = new Set(saved.hiddenIds ?? []);
  // A built-in station the scan no longer makes (a show's name is read differently now, say) is
  // kept, with everything the user did to it, as long as any of its files are still here.
  // Never drop someone's station because of how a folder was parsed.
  const freshIds = new Set(fresh.map((channel) => channel.id));
  const onDisk = new Set(CATALOG.map((film) => film.id));
  const custom = saved.channels.filter(
    (channel) => !channel.id.startsWith(AUTO) || (!freshIds.has(channel.id) && channel.mediaIds.some((id) => onDisk.has(id))),
  );
  const lineup = (channel: Channel) => channel.mediaIds.slice().sort().join();
  const keptLineups = new Set(custom.map(lineup));
  const used = new Set(custom.map((channel) => channel.number));
  const kept: Channel[] = [];
  const added: Channel[] = [];
  for (const channel of fresh) {
    if (hidden.has(channel.id)) continue;
    // The same lineup under a new id is the station already kept above, not a new one.
    if (!old.has(channel.id) && keptLineups.has(lineup(channel))) continue;
    const before = old.get(channel.id);
    if (before?.edited) {
      used.add(before.number);
      kept.push(before);
      continue;
    }
    // No built-in station is ever added on its own any more. Only ones already there are refreshed.
    if (!before) continue;
    used.add(before.number);
    kept.push({
      ...channel,
      number: before.number,
      name: before.name,
      callSign: before.callSign,
      favorite: before.favorite,
      color: before.color,
      mode: before.mode,
      anchorMs: before.mode === channel.mode ? channel.anchorMs : before.anchorMs,
    });
  }
  for (const channel of added) {
    let number = 2;
    while (used.has(number)) number += 1;
    used.add(number);
    kept.push({ ...channel, number });
  }
  const channels = [...kept, ...custom].map((channel) => {
    // The first station is made before the first scan has finished on a slow disk, so it can be
    // saved empty. Untouched, it means "everything": fill it from today's disk.
    if (channel.id === `${AUTO}all` && channel.mediaIds.length === 0 && !channel.edited) return { ...channel, mediaIds: CATALOG.map((film) => film.id) };
    return channel;
  });
  if (channels.length === 0) return saved;
  const has = (id: string | null) => id != null && channels.some((channel) => channel.id === id);
  return {
    ...saved,
    channels,
    tunedId: has(saved.tunedId) ? saved.tunedId : (channels[0]?.id ?? saved.tunedId),
    lastId: has(saved.lastId) ? saved.lastId : null,
  };
}

export function createFactoryState(): ParlorState {
  // A brand-new library starts with one station that plays everything, nothing more.
  // Every other station is one the user makes.
  if (isDiskLibrary()) {
    const everything = createDiskState().channels.find((channel) => channel.id === `${AUTO}all`);
    const channel: Channel = everything ?? {
      id: `${AUTO}all`,
      number: 2,
      name: "Everything",
      callSign: "EVRY",
      mode: "shuffle",
      shuffleSeed: `${AUTO}all`,
      anchorMs: DISK_ANCHOR,
      mediaIds: CATALOG.map((film) => film.id),
      query: null,
    };
    return { channels: [{ ...channel, number: 2 }], missingIds: [], tunedId: channel.id, lastId: null, powered: true };
  }
  const channels: Channel[] = [
    smartChannel({
      id: "ch-iron",
      number: 4,
      name: "Iron Harvest",
      callSign: "WIRN",
      mode: "loop",
      query: "iron harvest",
    }),
    smartChannel({
      id: "ch-dark",
      number: 7,
      name: "After Dark",
      callSign: "KDRK",
      mode: "shuffle",
      query: "horror",
    }),
    smartChannel({
      id: "ch-grow",
      number: 12,
      name: "Growing Up",
      callSign: "WGRO",
      mode: "loop",
      query: "coming of age",
    }),
    smartChannel({
      id: "ch-voss",
      number: 16,
      name: "Lena Voss",
      callSign: "KVOX",
      mode: "loop",
      query: "lena voss",
    }),
    smartChannel({
      id: "ch-far",
      number: 21,
      name: "Far Signal",
      callSign: "KFAR",
      mode: "shuffle",
      query: "science fiction",
    }),
  ];
  return {
    channels,
    missingIds: ["blueprints", "milk-glass"],
    tunedId: "ch-iron",
    lastId: null,
    powered: true,
  };
}
