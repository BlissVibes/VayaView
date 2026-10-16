import type { Airing } from "../schedule/types.ts";
import type { Film } from "../library/types.ts";

/**
 * PLAYER SEAM
 * The preview draws a stand-in picture. The desktop port plays `filePath`
 * with libmpv (hardware decode) and seeks to `offsetMs`. One player.
 * Do not decode channels that are not on screen.
 */
export type PlayRequest = {
  mediaId: string;
  filePath: string | null;
  offsetMs: number;
  status: "ready" | "missing";
};

export type PlayerBackendId = "preview-picture" | "libmpv";

/**
 * STREAM SEAM — not used by the preview.
 * Open a session only when a remote screen tunes in, at the same offset the
 * local clock already computed. `direct` copies the file. `transcode` is one
 * encode for that session, never a standing encode per channel.
 */
export type StreamSession = {
  channelId: string;
  mediaId: string;
  offsetMs: number;
  mode: "direct" | "transcode";
};

export function playRequestFor(airing: Airing, film: Film | null): PlayRequest {
  return {
    mediaId: airing.slot.mediaId,
    filePath: film?.filePath ?? null,
    offsetMs: airing.offsetMs,
    status: airing.slot.status,
  };
}

export function streamSessionFor(
  channelId: string,
  request: PlayRequest,
  direct: boolean,
): StreamSession {
  return {
    channelId,
    mediaId: request.mediaId,
    offsetMs: request.offsetMs,
    mode: direct ? "direct" : "transcode",
  };
}
