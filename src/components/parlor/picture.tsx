import { useEffect, useRef, useState, type ReactNode } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/cn";
import { durable } from "@/lib/durable";
import { isRemote } from "@/lib/remote";
import { formatDuration, formatStation, formatTime } from "@/lib/format";
import type { PlayRequest } from "@/lib/player/seam";
import { streamCues, type Cue } from "@/lib/player/subs";
import type { Airing, Channel } from "@/lib/schedule/types";
import type { Film, SubTrack } from "@/lib/library/types";
import { LiftFilter, videoFilter, type Adjust } from "./picture-adjust";
import { YouTubeFrame } from "./youtube-frame";

type PictureProps = {
  powered: boolean;
  channel: Channel | null;
  airing: Airing | null;
  film: Film | null;
  request: PlayRequest | null;
  digits: string;
  notice: string | null;
  /** Position of the chosen sound track among the file's audio streams. */
  audio: number;
  sub: SubTrack | null;
  /** This film's own black level, brightness and contrast. Absent or neutral: the picture as it is. */
  adjust?: Adjust;
  /** Small picture inside the guide. The guide shows the title, so the card stays off. */
  compact: boolean;
  /** Controls shown with the title card in full view. */
  toolbar?: ReactNode;
  /** Shown along the bottom of the card in full view. */
  footer?: ReactNode;
  /** Goes up each time the viewer scrubs or returns to live, so the picture jumps at once. */
  seekToken: number;
  /** Stopped on a frame by the viewer. The clock-follow below leaves it be until this clears. */
  paused?: boolean;
  onToggleView: () => void;
  /** YouTube refused the video playing now (its error code). The app moves on to another video. */
  onRefused?: (mediaId: string, code: number) => void;
  className?: string;
};

/** How long the title card stays up once real frames are showing. */
const CARD_MS = 5000;

/** This phone page. Each tune gets its own stream under it, so an old stream's last pieces never mix into a new one. */
const HLS_SESSION = Math.random().toString(36).slice(2, 12);
let hlsTune = 0;

/**
 * Where a stream comes from. On the PC: the file, or one ffmpeg stream. On a phone
 * (an iPhone wants Apple's HLS format): the same choices, cut into HLS pieces.
 */
function streamUrl(mediaId: string, query: string): string {
  return isRemote ? `/hls/${HLS_SESSION}-${++hlsTune}/${mediaId}/index.m3u8?${query}` : `/media/${mediaId}?${query}`;
}

/**
 * How the file reaches the screen, cheapest first.
 * 0 plays the file as it is. 1 keeps the picture and converts only the sound.
 * 2 re-encodes the picture too. A refusal moves one step down the list.
 */
type Level = 0 | 1 | 2;

export function Picture(props: PictureProps) {
  const { powered, channel, airing, film, request, digits, notice, audio, sub, adjust, compact, toolbar, footer, seekToken, paused = false, onToggleView, onRefused, className } = props;
  const station = channel ? formatStation(channel.number) : "--";
  const missing = request?.status === "missing";

  const videoRef = useRef<HTMLVideoElement>(null);
  // The clock owns the offset. The player only reads it when it tunes.
  const offsetRef = useRef(0);
  offsetRef.current = request?.offsetMs ?? 0;
  /** Seconds into the film where the current ffmpeg session began. 0 for direct play. */
  const baseRef = useRef(0);
  const cuesRef = useRef<Cue[]>([]);
  const [bump, setBump] = useState<{ key: string; level: Level } | null>(null);
  const [reload, setReload] = useState(0);
  /** The stream this player was last told to play. An error from any older one is old news. */
  const srcRef = useRef("");
  /** When the picture was last tuned, and to what, to notice fast flipping. */
  const lastTune = useRef({ key: "" as string | null, at: 0 });
  const retries = useRef(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [card, setCard] = useState(true);
  const [poke, setPoke] = useState(0);
  const lastPoke = useRef(0);
  const [line, setLine] = useState("");

  const mediaId = powered && request && request.status === "ready" && request.filePath ? request.mediaId : null;
  const tuneKey = mediaId && channel && airing ? `${channel.id}:${mediaId}:${airing.cycleIndex}:${airing.slotIndex}` : null;
  // A YouTube video plays in YouTube's own player. Everything below that opens a file (the stream, the
  // keyframe question, subtitles, /media) sees no file, and stays out of it.
  const youtubeId = mediaId && film?.youtubeId ? film.youtubeId : null;
  /** YouTube refused this video (an error code from its player). Cleared by the next tune. */
  const [ytError, setYtError] = useState<{ key: string; code: number } | null>(null);
  const ytRefused = youtubeId && tuneKey && ytError?.key === tuneKey ? ytError.code : null;
  // A phone cannot follow onto a YouTube station: the embed plays on the PC only.
  const ytElsewhere = youtubeId != null && isRemote;
  const fileId = youtubeId ? null : mediaId;
  const fileTuneKey = youtubeId ? null : tuneKey;
  const burn = sub && !sub.text ? sub.key : null;
  const canCopy = film?.vcodec === "h264" || film?.vcodec === "hevc";
  // A phone never plays the file directly (an iPhone cannot open MKV); it starts at the copy step.
  const startLevel: Level = burn != null ? 2 : !isRemote && film?.direct !== false && audio === 0 ? 0 : canCopy ? 1 : 2;
  const playKey = fileTuneKey ? `${fileTuneKey}:${audio}:${burn ?? ""}` : null;
  const level: Level = bump && bump.key === playKey && bump.level > startLevel ? bump.level : startLevel;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setFailed(false);
    if (!playKey || !fileId) {
      video.removeAttribute("src");
      video.load();
      return;
    }
    const mediaId = fileId;
    let cancelled = false;
    const control = new AbortController();
    // Removed when this stream is replaced, so a late one can never seek the next stream (an ffmpeg
    // stream that is seeked starts over, at the cost of a second encode).
    const onLoaded: Array<() => void> = [];
    const whenLoaded = (fn: () => void) => {
      const once = () => {
        video.removeEventListener("loadedmetadata", once);
        if (!cancelled) fn();
      };
      onLoaded.push(once);
      video.addEventListener("loadedmetadata", once);
    };
    const begin = (src: string, base: number) => {
      if (cancelled) return;
      baseRef.current = base;
      srcRef.current = src;
      video.src = src;
      if (isRemote) {
        // A stream starts on the keyframe at or before the moment asked for. Skip ahead to the clock,
        // so the phone is not seconds behind the PC.
        whenLoaded(() => {
          const ahead = offsetRef.current / 1000 - baseRef.current;
          if (ahead > 0.5) video.currentTime = ahead;
        });
      }
      video.play().catch(() => {
        // Sound refused before the first click. Start silent instead of black.
        video.muted = true;
        setMuted(true);
        video.play().catch(() => {});
      });
    };
    const go = () => {
      const start = offsetRef.current / 1000;
      if (level === 0) {
        whenLoaded(() => (video.currentTime = offsetRef.current / 1000));
        begin(`/media/${mediaId}`, 0);
      } else if (level === 1) {
        // A copied picture can only start on a keyframe. Ask which one, so subtitles and the clock stay honest.
        // No keyframe nearby means no honest starting point, so that file is re-encoded instead.
        // A channel change cancels the question, and the server stops ffprobe.
        fetch(`/api/keyframe/${mediaId}?t=${start.toFixed(2)}`, { signal: control.signal })
          .then((response) => response.json() as Promise<{ found: boolean; t: number; base: number }>)
          .catch(() => null)
          .then((body) => {
            if (cancelled) return;
            if (body?.found) begin(streamUrl(mediaId, `v=copy&a=${audio}&t=${body.t.toFixed(3)}`), body.base);
            else setBump({ key: playKey, level: 2 });
          });
      } else {
        begin(streamUrl(mediaId, `v=enc&a=${audio}&t=${start.toFixed(2)}${burn != null ? `&burn=${burn}` : ""}`), start);
      }
    };
    // Flipping through stations: a station passed within a moment of the last is opened only once the
    // keys stop, so no stream is started for each one on the way.
    const quick = lastTune.current.key !== playKey && Date.now() - lastTune.current.at < 400;
    lastTune.current = { key: playKey, at: Date.now() };
    const timer = quick ? window.setTimeout(go, 300) : null;
    if (!quick) go();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      control.abort();
      for (const once of onLoaded) video.removeEventListener("loadedmetadata", once);
    };
  }, [playKey, fileId, level, audio, burn, reload]);

  useEffect(() => {
    retries.current = 0;
  }, [playKey]);

  // Pause and play on the viewer's word. While paused the clock-follow below stays out of it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playKey) return;
    if (paused) video.pause();
    else if (video.paused && !video.ended) video.play().catch(() => {});
  }, [paused, playKey]);

  // Once a second: if the picture drifted from the clock (sleep, stall), rejoin.
  useEffect(() => {
    const video = videoRef.current;
    if (paused || !video || !playKey || video.readyState < 3 || video.seeking) return;
    const expected = offsetRef.current / 1000 - baseRef.current;
    if (level === 0) {
      if (Math.abs(video.currentTime - expected) > 4 && expected < video.duration) video.currentTime = expected;
    } else if (isRemote && Math.abs(video.currentTime - expected) > 3 && video.seekable.length > 0 && expected <= video.seekable.end(video.seekable.length - 1)) {
      // On a phone the stream runs ahead of playback, so a small slip is fixed by skipping, not by starting over.
      video.currentTime = expected;
    } else if (Math.abs(video.currentTime - expected) > 25) {
      setReload((value) => value + 1);
    }
    if (video.paused && !video.ended) video.play().catch(() => {});
  }, [airing?.offsetMs, playKey, level, paused]);

  // A scrub, or a return to live: jump now. A session cannot seek, so it is restarted at the new spot.
  const lastSeek = useRef({ token: seekToken, key: playKey });
  useEffect(() => {
    const before = lastSeek.current;
    lastSeek.current = { token: seekToken, key: playKey };
    // A new programme loads at the right place by itself.
    if (before.token === seekToken || before.key !== playKey) return;
    const video = videoRef.current;
    if (!video || !playKey) return;
    if (level === 0) video.currentTime = offsetRef.current / 1000;
    else setReload((value) => value + 1);
  }, [seekToken, playKey, level]);

  // Text subtitles: the lines from just before now, drawn here, not by the browser. The first time a
  // track is asked for, the server sends the next stretch while it copies the whole track once; the
  // copy is fetched as soon as it is ready.
  const textSub = sub?.text ? sub.key : null;
  useEffect(() => {
    cuesRef.current = [];
    setLine("");
    if (!fileId || textSub == null) return;
    const mediaId = fileId;
    const from = Math.max(0, offsetRef.current / 1000 - 15);
    const control = new AbortController();
    const url = `/subs/${mediaId}?s=${textSub}&t=${from.toFixed(1)}`;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        control.signal.addEventListener("abort", () => (window.clearTimeout(timer), resolve()), { once: true });
      });
    void (async () => {
      let result = await streamCues(url, from, control.signal, (cue) => cuesRef.current.push(cue));
      for (let tries = 0; (result === "partial" || result === "waiting") && tries < 120; tries++) {
        await pause(10_000);
        if (control.signal.aborted) return;
        const fresh: Cue[] = [];
        result = await streamCues(`${url}&cached=1`, from, control.signal, (cue) => fresh.push(cue));
        if (result === "whole" && !control.signal.aborted) cuesRef.current = fresh;
      }
    })();
    return () => control.abort();
  }, [fileTuneKey, fileId, textSub, seekToken]);

  function onTime() {
    const video = videoRef.current;
    if (!video || cuesRef.current.length === 0) return;
    const at = video.currentTime + baseRef.current;
    let text = "";
    for (const cue of cuesRef.current) if (cue.start <= at && at < cue.end) text = text ? `${text}\n${cue.text}` : cue.text;
    setLine(text);
  }

  useEffect(() => {
    setCard(true);
    const timer = window.setTimeout(() => setCard(false), CARD_MS);
    return () => window.clearTimeout(timer);
  }, [tuneKey, poke]);

  // Volume: a slider at the bottom left of the picture, and the scroll wheel while over the picture
  // (and nowhere else). Remembered between runs. A phone uses its own volume buttons instead.
  const frameRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(() => {
    const saved = durable.getItem("parlor.volume");
    const value = Number(saved);
    return saved != null && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
  });
  const [volumeShown, setVolumeShown] = useState(false);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  function changeVolume(next: number) {
    const value = Math.min(1, Math.max(0, Math.round(next * 100) / 100));
    setVolume(value);
    setVolumeShown(true);
    // The YouTube frame takes its volume and mute from these two states.
    if (youtubeRef.current) {
      if (value > 0) setMuted(false);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    if (value > 0 && video.muted) {
      video.muted = false;
      setMuted(false);
    }
  }
  const changeRef = useRef(changeVolume);
  changeRef.current = changeVolume;
  /** True while the YouTube frame is the player, for handlers set up once (the M key, the wheel). */
  const youtubeRef = useRef(false);
  youtubeRef.current = youtubeId != null && !ytElsewhere;

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, playKey]);

  // Mute is one setting for both players: back on a file after a muted YouTube video, the file stays muted too.
  useEffect(() => {
    if (videoRef.current && playKey) videoRef.current.muted = muted;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the file changes; toggleMute sets it otherwise
  }, [playKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => durable.setItem("parlor.volume", volume.toFixed(2)), 400);
    return () => window.clearTimeout(timer);
  }, [volume]);

  useEffect(() => {
    if (!volumeShown) return;
    const timer = window.setTimeout(() => setVolumeShown(false), 1500);
    return () => window.clearTimeout(timer);
  }, [volumeShown, volume]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || isRemote) return;
    // A native listener, so the wheel can be kept from doing anything else while over the picture.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      changeRef.current(volumeRef.current + (event.deltaY < 0 ? 0.05 : -0.05));
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, []);

  function toggleMute() {
    if (youtubeRef.current) return setMuted((value) => !value);
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "m" || event.key === "M") toggleMute();
      if (event.key === "f" || event.key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ytBroken = ytRefused != null || ytElsewhere;
  const live = mediaId != null && !failed && !ytBroken;
  const showing = powered && !digits && airing != null && film != null && !missing && !failed;
  const hideCard = live && !digits && !notice && (compact || !card);
  const filter = adjust ? videoFilter(adjust) : undefined;

  return (
    <div
      onMouseMove={() => {
        // Keep the card up while the mouse is in use, without restarting the timer on every pixel.
        if (!live || compact || (card && Date.now() - lastPoke.current < 800)) return;
        lastPoke.current = Date.now();
        setPoke((value) => value + 1);
      }}
      ref={frameRef}
      onClick={live ? toggleMute : undefined}
      onDoubleClick={onToggleView}
      className={cn("group relative h-full w-full overflow-hidden bg-screen text-cream [container-type:inline-size]", hideCard && !compact ? "cursor-none" : "", className)}
    >
      {/* With a filter on, the black bars sit behind the video instead of in it, so they stay black. */}
      {filter ? (
        <>
          <LiftFilter lift={adjust?.lift ?? 0} />
          <div className={cn("absolute inset-0 bg-black", live ? "" : "hidden")} />
        </>
      ) : null}
      <video
        ref={videoRef}
        playsInline
        onTimeUpdate={onTime}
        className={cn("absolute inset-0 h-full w-full object-contain", filter ? "" : "bg-black", live && !youtubeId ? "" : "hidden")}
        style={filter ? { filter } : undefined}
        onError={() => {
          if (!playKey) return;
          // A stream being replaced can still report a failure after the new one has started. Ignore it.
          if (srcRef.current && !video_src_matches(videoRef.current, srcRef.current)) return;
          // A phone stream sometimes stumbles while it starts. Try the same way again before trying a heavier one.
          if (isRemote && retries.current < 2) {
            retries.current += 1;
            window.setTimeout(() => setReload((value) => value + 1), 800);
            return;
          }
          if (level === 0) setBump({ key: playKey, level: canCopy ? 1 : 2 });
          else if (level === 1) setBump({ key: playKey, level: 2 });
          else setFailed(true);
        }}
      />

      {youtubeId && tuneKey && !ytElsewhere ? (
        <YouTubeFrame
          videoId={youtubeId}
          offsetRef={offsetRef}
          tuneKey={tuneKey}
          seekToken={seekToken}
          paused={paused}
          muted={muted}
          volume={volume}
          onError={(code) => {
            setYtError({ key: tuneKey, code });
            if (mediaId) onRefused?.(mediaId, code);
          }}
          onAutoMuted={() => setMuted(true)}
          className={ytRefused != null ? "hidden" : undefined}
        />
      ) : null}

      {live ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-black/60 transition-opacity duration-500",
            hideCard ? "opacity-0" : "opacity-100",
          )}
        />
      ) : null}

      {live && line ? (
        <p
          className="pointer-events-none absolute inset-x-0 bottom-[7%] z-20 px-[6%] text-center leading-snug font-medium whitespace-pre-line text-white"
          style={{ fontSize: "clamp(0.8rem, 2.4cqw, 2.6rem)", textShadow: "0 0 4px #000, 0 2px 6px #000, 0 0 2px #000" }}
        >
          {line}
        </p>
      ) : null}

      {live && !isRemote ? (
        <div
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            "absolute left-3 z-30 flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-cream transition-opacity duration-300",
            compact ? "bottom-3" : "bottom-24",
            volumeShown || muted || (!compact && !hideCard) ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title="Mute (M)" className="text-cream/90 hover:text-cream">
            {muted || volume === 0 ? <VolumeX className="size-4" /> : volume < 0.5 ? <Volume1 className="size-4" /> : <Volume2 className="size-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : Math.round(volume * 100)}
            onChange={(event) => changeVolume(Number(event.target.value) / 100)}
            aria-label="Volume"
            title="Volume (or scroll over the picture)"
            className="h-1 w-24 cursor-pointer accent-accent"
          />
          <span className="w-7 text-right text-xs text-cream/80 tabular-nums">{muted ? "0" : Math.round(volume * 100)}</span>
        </div>
      ) : null}

      {live && muted ? (
        <p className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-cream">
          Muted · click the picture for sound
        </p>
      ) : null}

      {live && paused ? (
        <p className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-5 py-2 text-sm tracking-[0.2em] text-cream uppercase">
          ❚❚ Paused
        </p>
      ) : null}

      <div
        className={cn(
          // Titles in the plain face, not the serif: it read too loud over the picture.
          "relative z-10 flex h-full flex-col justify-between p-4 transition-opacity duration-500 sm:p-6 [&_h1]:font-sans [&_h1]:font-semibold [&_h1]:tracking-tight",
          hideCard ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        {/* Top left: the station number, and beside it what is on. Top right: the controls. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-4">
            <p className="font-title shrink-0 text-3xl leading-none font-semibold tracking-tight tabular-nums sm:text-4xl">{station}</p>
            <div className="min-w-0">
              <p className="text-xs tracking-[0.22em] text-cream/70 uppercase">
                {channel ? `${channel.callSign} · ${channel.name}` : "VayaView"}
              </p>
              {showing && airing && film ? (
                <div key={`${airing.slot.mediaId}-${airing.cycleIndex}`} className="parlor-in mt-1.5">
                  <h1 className="font-title text-xl leading-tight sm:text-3xl">{film.title}</h1>
                  <p className="mt-1 text-sm text-cream/70 tabular-nums">
                    {formatDuration(airing.offsetMs)} in · {formatDuration(airing.remainingMs)} left
                    {airing.next ? ` · Next ${airing.next.title} at ${formatTime(airing.endsAtMs)}` : ""}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          {toolbar && !compact ? (
            <div className="shrink-0" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
              {toolbar}
            </div>
          ) : null}
        </div>

        <div key={airing ? `${airing.slot.mediaId}-${airing.cycleIndex}` : "idle"} className="parlor-in max-w-3xl">
          {digits ? (
            <p className="font-title text-6xl font-semibold tracking-tight tabular-nums sm:text-7xl">{digits}</p>
          ) : !powered ? (
            <>
              <h1 className="text-3xl leading-tight sm:text-5xl">Standby</h1>
              <p className="mt-3 max-w-md text-sm text-cream/70">The stations keep their clock. P turns the set back on.</p>
            </>
          ) : !airing || !film ? (
            <h1 className="text-3xl leading-tight sm:text-4xl">Joining the broadcast</h1>
          ) : missing ? (
            <>
              <p className="text-xs tracking-[0.18em] text-accent uppercase">Not on this computer</p>
              <h1 className="mt-2 text-2xl leading-tight sm:text-4xl">{film.title}</h1>
              <p className="mt-3 max-w-lg text-sm text-pretty text-cream/75">
                The slot stays on the schedule so the station does not skip ahead.
                {airing.next ? ` Next is ${airing.next.title}.` : ""}
              </p>
            </>
          ) : failed ? (
            <p className="text-sm text-accent">This file would not play, even through ffmpeg.</p>
          ) : ytElsewhere ? (
            <>
              <h1 className="text-2xl leading-tight sm:text-4xl">{film.title}</h1>
              <p className="mt-3 text-sm text-accent">YouTube stations play on the PC only.</p>
            </>
          ) : ytRefused != null ? (
            <>
              <h1 className="text-2xl leading-tight sm:text-4xl">{film.title}</h1>
              <p className="mt-3 max-w-lg text-sm text-accent">
                {ytRefused === 101 || ytRefused === 150
                  ? `This video can't be embedded; YouTube only allows it on youtube.com (error ${ytRefused}).`
                  : ytRefused === 100
                    ? "This video has been removed from YouTube, or made private."
                    : `YouTube would not play this video (error ${ytRefused}).`}
                {airing.next ? ` Next is ${airing.next.title}.` : ""}
              </p>
            </>
          ) : null}
          {notice ? <p className="mt-4 text-sm text-accent">{notice}</p> : null}
        </div>
        <div onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          {live && !compact ? footer : null}
        </div>
      </div>
    </div>
  );
}

function video_src_matches(video: HTMLVideoElement | null, src: string): boolean {
  return Boolean(video && video.src.endsWith(src.replace(/^https?:\/\/[^/]+/, "")));
}
