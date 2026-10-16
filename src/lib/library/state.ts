import type { Channel } from "../schedule/types.ts";

export const STORAGE_KEY = "parlor.v2";

export type ParlorState = {
  channels: Channel[];
  missingIds: string[];
  tunedId: string;
  lastId: string | null;
  powered: boolean;
  /** Built-in stations the user removed. The next scan leaves them out. */
  hiddenIds?: string[];
};
