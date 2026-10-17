import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";

/**
 * YouTube's own embedded player, standing in for the <video> when the programme is a YouTube video.
 * Nothing is downloaded: the video plays from youtube.com inside the picture, the station's clock
 * decides where, exactly as it does for a file.
 *
 * The player is made once and reused: a tune to another YouTube video loads it into the same frame.
 * The frame never takes the pointer (clicks go to the picture underneath, for mute, double-click and
 * full view) and gives the keyboard back as soon as it is ready, so station keys keep working.
 */

/** The parts of the IFrame Player API used here. See developers.google.com/youtube/iframe_api_reference. */
type YtPlayer = {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getIframe(): HTMLIFrameElement;
  destroy(): void;
};
type YtNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      width: string;
      height: string;
      host?: string;
      playerVars: Record<string, string | number>;
      events: { onReady: () => void; onError: (event: { data: number }) => void; onStateChange?: (event: { data: number }) => void };
    },
  ) => YtPlayer;
};
type YtWindow = Window & { YT?: YtNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };

/** Player states, as getPlayerState() gives them. */
const UNSTARTED = -1;
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const CUED = 5;

/** The clock and the picture may disagree by this much (seconds) before the picture is moved. Same as a file. */
const DRIFT_S = 4;

let apiReady: Promise<YtNamespace> | null = null;

/** The IFrame API script, loaded once for the whole app. */
function loadApi(): Promise<YtNamespace> {
  const win = window as YtWindow;
  if (win.YT?.Player) return Promise.resolve(win.YT);
  if (apiReady) return apiReady;
  apiReady = new Promise<YtNamespace>((resolve, reject) => {
    const before = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      before?.();
      if (win.YT) resolve(win.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      // Offline, or youtube.com blocked. Let a later tune try again.
      apiReady = null;
      script.remove();
      reject(new Error("YouTube could not be reached."));
    };
    document.head.appendChild(script);
  });
  return apiReady;
}

type YouTubeFrameProps = {
  videoId: string;
  /** Milliseconds into the video the station's clock (or a held scrub) says it should be now. Read, never written. */
  offsetRef: RefObject<number>;
  /** Changes with every tune: another station, another programme, another cycle. A change loads the video afresh. */
  tuneKey: string;
  /** Goes up on every scrub or return to live, so the frame jumps at once. */
  seekToken: number;
  paused: boolean;
  muted: boolean;
  /** 0 to 1, the picture's own volume slider. */
  volume: number;
  /** YouTube refused the video: 100 (removed or private), 101 and 150 (the owner does not allow embedding), 2 and 5 (bad id, player error). */
  onError: (code: number) => void;
  /** The browser would not start the sound by itself, so the video was started muted. */
  onAutoMuted?: () => void;
  onReady?: () => void;
  className?: string;
};

export function YouTubeFrame({ videoId, offsetRef, tuneKey, seekToken, paused, muted, volume, onError, onAutoMuted, onReady, className }: YouTubeFrameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  /** Set once YouTube has refused the current video. Nothing retries it until the next tune. */
  const refused = useRef(false);
  const live = useRef({ paused, muted, onError, onAutoMuted, onReady });
  live.current = { paused, muted, onError, onAutoMuted, onReady };

  // One player for as long as YouTube programmes follow each other. It goes when the picture
  // moves on to a file (this component is unmounted then).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let gone = false;
    // The API replaces the element it is given with its iframe, so it gets one React does not own.
    const mount = document.createElement("div");
    host.appendChild(mount);
    loadApi()
      .then((YT) => {
        if (gone) return;
        playerRef.current = new YT.Player(mount, {
          width: "100%",
          height: "100%",
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            iv_load_policy: 3,
            fs: 0,
            origin: location.origin,
            enablejsapi: 1,
          },
          events: {
            onReady: () => {
              if (gone) return;
              const frame = playerRef.current?.getIframe();
              // Keyboard focus stays with the app: the frame cannot be tabbed to and gives focus back now.
              frame?.setAttribute("tabindex", "-1");
              window.focus();
              setReady(true);
              live.current.onReady?.();
            },
            onError: (event) => {
              if (gone) return;
              refused.current = true;
              live.current.onError(event.data);
            },
          },
        });
      })
      .catch(() => {
        if (!gone) setUnreachable(true);
      });
    return () => {
      gone = true;
      try {
        playerRef.current?.destroy();
      } catch {
        // Already gone with its frame.
      }
      playerRef.current = null;
      host.replaceChildren();
    };
  }, []);

  // A tune: load the video at the clock's point. Flipping fast through YouTube stations loads only
  // the one the keys stop on, like the file player does.
  const lastLoad = useRef(0);
  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player) return;
    refused.current = false;
    const go = () => {
      lastLoad.current = Date.now();
      player.loadVideoById({ videoId, startSeconds: Math.max(0, offsetRef.current / 1000) });
      if (live.current.paused) player.pauseVideo();
    };
    const quick = Date.now() - lastLoad.current < 400;
    lastLoad.current = Date.now();
    const timer = quick ? window.setTimeout(go, 300) : null;
    if (!quick) go();
    // Sound refused before the first click: start silent instead of black, as the file player does.
    // A slow start looks the same for a while, so first it is only asked to play; muted only if that did not take.
    const notStarted = () => {
      const state = player.getPlayerState();
      return !refused.current && !live.current.paused && !live.current.muted && (state === UNSTARTED || state === CUED || state === PAUSED);
    };
    let second: number | null = null;
    const check = window.setTimeout(() => {
      if (!notStarted()) return;
      player.playVideo();
      second = window.setTimeout(() => {
        if (!notStarted()) return;
        player.mute();
        player.playVideo();
        live.current.onAutoMuted?.();
      }, 2500);
    }, 3000 + (quick ? 300 : 0));
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.clearTimeout(check);
      if (second != null) window.clearTimeout(second);
    };
  }, [ready, videoId, tuneKey, offsetRef]);

  // A scrub or Back to Live: jump now. A new tune loads at the right place by itself.
  const lastSeek = useRef({ token: seekToken, key: tuneKey });
  useEffect(() => {
    const before = lastSeek.current;
    lastSeek.current = { token: seekToken, key: tuneKey };
    if (before.token === seekToken || before.key !== tuneKey) return;
    const player = playerRef.current;
    if (!ready || !player || refused.current) return;
    player.seekTo(Math.max(0, offsetRef.current / 1000), true);
    if (live.current.paused) player.pauseVideo();
  }, [seekToken, tuneKey, ready, offsetRef]);

  // Pause and play on the viewer's word.
  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player || refused.current) return;
    if (paused) player.pauseVideo();
    else player.playVideo();
  }, [paused, ready]);

  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player) return;
    if (muted) player.mute();
    else player.unMute();
    player.setVolume(Math.round(volume * 100));
  }, [muted, volume, ready]);

  // Once a second: if the picture drifted from the clock (a stall, a sleep, an ad YouTube slipped
  // in), rejoin. If it stopped by itself while it should be playing, start it again.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      if (!player || refused.current || live.current.paused) return;
      const state = player.getPlayerState();
      const expected = Math.max(0, offsetRef.current / 1000);
      const duration = player.getDuration();
      // The listing's length and the player's can differ by a second or two. Past the player's end there is nothing to join.
      const inside = !duration || expected < duration - 1;
      if ((state === PLAYING || state === PAUSED || state === BUFFERING) && inside && Math.abs(player.getCurrentTime() - expected) > DRIFT_S) {
        player.seekTo(expected, true);
      } else if (state === ENDED && inside) {
        player.seekTo(expected, true);
      } else if ((state === PAUSED || state === UNSTARTED || state === CUED) && inside) {
        // Stopped by itself, or never started (a hidden window may not start media): ask again.
        player.playVideo();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ready, offsetRef]);

  return (
    <div className={cn("pointer-events-none absolute inset-0 bg-black [&_iframe]:pointer-events-none [&_iframe]:h-full [&_iframe]:w-full", className)}>
      <div ref={hostRef} className="h-full w-full" />
      {unreachable ? <p className="absolute inset-x-0 top-1/2 text-center text-sm text-accent">YouTube could not be reached. Check the Internet connection.</p> : null}
    </div>
  );
}
