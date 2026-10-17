export type ChannelMode = "loop" | "shuffle";

/**
 * How a tune-in lands. "clock" joins wherever the station's clock says, like every broadcast station.
 * "start" lands somewhere in the first tenth of what is on. "peaks" lands just before one of the
 * moments YouTube viewers replay most (YouTube videos only; anything else lands as "start").
 */
export type SurfMode = "clock" | "start" | "peaks";

/** Where a YouTube station's lineup came from: the channel, which kind of its videos, and the list that kind was read from. */
export type YoutubeSource = { channel: string; channelUrl: string; kind: string; url: string };

/**
 * A channel is a locked lineup plus a wall-clock anchor.
 * Smart searches write `mediaIds` when the user applies them.
 * They do not re-roll on every launch — that would be a playlist, not a station.
 */
export type Channel = {
  id: string;
  number: number;
  name: string;
  callSign: string;
  mode: ChannelMode;
  /** Shuffle order is hash(shuffleSeed + cycle). Loop ignores this. */
  shuffleSeed: string;
  /**
   * Broadcast origin. What's on at `now` is (now - anchor) modulo the lineup,
   * whether or not the app was open.
   */
  anchorMs: number;
  mediaIds: string[];
  /** The search that built this lineup, or null if it was hand picked. */
  query: string | null;
  /** A built-in station whose lineup was changed by hand. Scans leave it alone. */
  edited?: boolean;
  favorite?: boolean;
  /** Colour of this station's bar in the guide. Favourites without one use the theme highlight. */
  color?: string;
  /** Set on a station made from YouTube videos. */
  youtube?: YoutubeSource;
  /** How a tune-in lands. Absent means "clock". */
  surf?: SurfMode;
  /** A station made by "Surf the tube": one video of the station with this id. */
  parentId?: string;
};

export type SlotStatus = "ready" | "missing";

export type Slot = {
  mediaId: string;
  title: string;
  durationMs: number;
  status: SlotStatus;
};

/** Anything the schedule can place. The player is not involved. */
export type Schedulable = {
  id: string;
  title: string;
  durationMs: number;
};

export type Airing = {
  channelId: string;
  cycleIndex: number;
  slotIndex: number;
  offsetMs: number;
  remainingMs: number;
  startedAtMs: number;
  endsAtMs: number;
  slot: Slot;
  next: Slot | null;
};

export type GuideSlot = {
  startsAtMs: number;
  endsAtMs: number;
  slot: Slot;
};
