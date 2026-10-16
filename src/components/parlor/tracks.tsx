import { useState } from "react";
import type { AudioTrack, Film, SubTrack } from "@/lib/library/types";
import { durable } from "@/lib/durable";

const PREF_KEY = "parlor.tracks";

type Prefs = { audioLang: string | null; subLang: string | null };
type Override = { audio?: number; sub?: string | null };

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(durable.getItem(PREF_KEY) ?? "null") as Partial<Prefs> | null;
    return { audioLang: saved?.audioLang ?? null, subLang: saved?.subLang ?? null };
  } catch {
    return { audioLang: null, subLang: null };
  }
}

const LANGUAGES: Record<string, string> = {
  eng: "English", en: "English", spa: "Spanish", fre: "French", fra: "French", ger: "German", deu: "German",
  ita: "Italian", jpn: "Japanese", kor: "Korean", chi: "Chinese", zho: "Chinese", por: "Portuguese", rus: "Russian",
  ara: "Arabic", hin: "Hindi", dut: "Dutch", nld: "Dutch", swe: "Swedish", und: "",
};

function language(code: string): string {
  return LANGUAGES[code.toLowerCase()] ?? code;
}

function layout(channels: number): string {
  if (channels >= 8) return "7.1";
  if (channels >= 6) return "5.1";
  if (channels === 2) return "Stereo";
  if (channels === 1) return "Mono";
  return "";
}

export function audioLabel(track: AudioTrack, i: number): string {
  const parts = [language(track.lang) || `Track ${i + 1}`, track.codec.toUpperCase(), layout(track.ch)].filter(Boolean);
  return track.title ? `${parts.join(" · ")} (${track.title})` : parts.join(" · ");
}

export function subLabel(track: SubTrack, i: number): string {
  const name = language(track.lang) || `Track ${i + 1}`;
  const title = track.title && track.title.toLowerCase() !== name.toLowerCase() ? ` (${track.title})` : "";
  return `${name}${title}${track.text ? "" : " · burned in"}`;
}

/**
 * Which sound and which subtitles for the film on screen. A choice sticks to
 * that film, and its language becomes the default for the next one, the way a
 * television keeps subtitles on across a channel change.
 */
export function useTracks(film: Film | null) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  // The Subtitles button: on means subtitles on every programme until it is switched off.
  const [alwaysSubs, setAlwaysSubs] = useState(() => durable.getItem("parlor.subsAlways") === "1");

  const audioTracks = film?.audio ?? [];
  const subTracks = film?.subs ?? [];
  const mine = film ? overrides[film.id] : undefined;

  let audio = mine?.audio ?? (prefs.audioLang ? audioTracks.findIndex((track) => track.lang === prefs.audioLang) : 0);
  if (audio < 0 || audio >= audioTracks.length) audio = 0;

  // Full dialogue first, text before picture-based. "Forced" and "signs" tracks are not what was asked for.
  const rank = (track: SubTrack) => (/forced|sign/i.test(track.title) ? 2 : 0) + (track.text ? 0 : 1);
  const best = (list: SubTrack[]) => list.slice().sort((a, b) => rank(a) - rank(b))[0]?.key ?? null;

  // Sound not in English (or no English sound at all): subtitles come on by themselves.
  const english = (lang: string) => ["eng", "en", "english"].includes(lang.toLowerCase());
  const chosenLang = audioTracks[audio]?.lang ?? "";
  const foreign = audioTracks.length > 0 && chosenLang !== "" && chosenLang !== "und" && !english(chosenLang);
  const wantSubs = alwaysSubs || foreign;

  let subKey: string | null = null;
  let automatic = false;
  if (mine && "sub" in mine) subKey = mine.sub ?? null;
  else if (prefs.subLang) subKey = best(subTracks.filter((track) => track.lang === prefs.subLang));
  if (subKey == null && !(mine && "sub" in mine) && wantSubs) {
    // English if there is any, otherwise whatever the file has.
    subKey = best(subTracks.filter((track) => english(track.lang))) ?? best(subTracks);
    automatic = subKey != null;
  }
  const sub = subTracks.find((track) => track.key === subKey) ?? null;

  function save(next: Prefs) {
    setPrefs(next);
    try {
      durable.setItem(PREF_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked. The choice still holds until the app closes.
    }
  }

  return {
    audioTracks,
    subTracks,
    audio,
    sub,
    alwaysSubs,
    /** Subtitles were switched on by a rule (always-on, or sound not in English), not picked by hand. */
    automatic,
    foreign,
    setAlwaysSubs(on: boolean) {
      setAlwaysSubs(on);
      durable.setItem("parlor.subsAlways", on ? "1" : "0");
      // Turning it on or off is a fresh start: forget any per-film "off" picked while it was the other way.
      setOverrides((all) => Object.fromEntries(Object.entries(all).map(([id, value]) => [id, { audio: value.audio }])));
    },
    setAudio(index: number) {
      if (!film) return;
      setOverrides((all) => ({ ...all, [film.id]: { ...all[film.id], audio: index } }));
      save({ ...prefs, audioLang: audioTracks[index]?.lang || null });
    },
    setSub(key: string | null) {
      if (!film) return;
      setOverrides((all) => ({ ...all, [film.id]: { ...all[film.id], sub: key } }));
      save({ ...prefs, subLang: key == null ? null : subTracks.find((track) => track.key === key)?.lang || null });
    },
  };
}

export type Tracks = ReturnType<typeof useTracks>;

const selectClass =
  "min-w-0 max-w-full rounded-md bg-black/60 px-2 py-1.5 text-xs text-cream outline-1 outline-cream/20 focus:outline-accent disabled:opacity-40";

/** Sound and subtitle pickers. Lists only what the file actually carries. */
export function TrackMenu({ tracks, className }: { tracks: Tracks; className?: string }) {
  return (
    <div className={className}>
      <label className="flex min-w-0 items-center gap-2 text-xs text-cream/60">
        <span className="w-16 shrink-0">Audio</span>
        <select
          className={selectClass}
          value={tracks.audio}
          disabled={tracks.audioTracks.length < 2}
          onChange={(event) => tracks.setAudio(Number(event.target.value))}
        >
          {tracks.audioTracks.length === 0 ? <option value={0}>None</option> : null}
          {tracks.audioTracks.map((track, i) => (
            <option key={i} value={i}>
              {audioLabel(track, i)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 items-center gap-2 text-xs text-cream/60">
        <span className="w-16 shrink-0">Subtitles</span>
        <select
          className={selectClass}
          value={tracks.sub?.key ?? ""}
          disabled={tracks.subTracks.length === 0}
          onChange={(event) => tracks.setSub(event.target.value || null)}
        >
          <option value="">{tracks.subTracks.length === 0 ? "None in this file" : "Off"}</option>
          {tracks.subTracks.map((track, i) => (
            <option key={track.key} value={track.key}>
              {subLabel(track, i)}
            </option>
          ))}
        </select>
        <button
          type="button"
          role="switch"
          aria-checked={tracks.alwaysSubs}
          title={tracks.alwaysSubs ? "Subtitles stay on for every programme. Click to go back to choosing them yourself." : "Turn subtitles on for every programme"}
          onClick={(event) => {
            event.preventDefault();
            tracks.setAlwaysSubs(!tracks.alwaysSubs);
          }}
          className={
            tracks.alwaysSubs
              ? "shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-room"
              : "shrink-0 rounded-md bg-cream/10 px-2 py-1 text-xs text-cream/80 hover:bg-cream/20"
          }
        >
          CC {tracks.alwaysSubs ? "on" : "auto"}
        </button>
      </label>
      {tracks.automatic && !tracks.alwaysSubs && tracks.foreign ? (
        <p className="text-[0.7rem] text-cream/45">Subtitles came on because the sound is not in English.</p>
      ) : null}
    </div>
  );
}
