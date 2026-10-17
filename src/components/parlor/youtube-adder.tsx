import { useEffect, useState, type FormEvent } from "react";
import { cn } from "@/lib/cn";
import { libraryInfo } from "@/lib/library/catalog";
import type { ParlorAction } from "@/lib/library/reducer";
import { rememberYoutube, youtubeMediaId, type Video } from "@/lib/library/youtube";
import type { Channel, SurfMode } from "@/lib/schedule/types";

/**
 * Stations from YouTube. Find a creator, pick the kinds of station their videos make (everything
 * they upload, the long ones, the compilations other people cut from them, each playlist), and
 * one click makes them all. Then their side channels: vlogs, music, clips. Every step asks yt-dlp
 * on the PC (server/youtube.mjs), which is slow, two to ten seconds, so each says it is busy.
 * Nothing is downloaded: the stations play YouTube's own player.
 */

type Status = { ytdlp: boolean; version: string | null };
type Found = { name: string; url: string; handle: string | null; sample: string[]; count: number | null };
type Kind = { key: string; label: string; count: number | null; url: string; note: string };
type ChannelInfo = { name: string; url: string; handle: string | null; videos: Video[]; kinds: Kind[] };
type Side = { name: string; url: string; count: number; reasons: string[]; sample: string[] };

/** One station to make: its name, where its videos come from, and how a tune-in lands. */
type Plan = { name: string; kind: string; url: string; surf: SurfMode; channel: string; channelUrl: string };

async function ask<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body || body.error) throw new Error(body?.error ?? `YouTube lookup failed (${response.status}).`);
  return body;
}

/** yt-dlp's version, or that it is missing. Shared with Settings › Surfing. */
export function useYtdlp() {
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try {
      setStatus(await ask<Status>("/api/youtube/status"));
    } catch {
      setStatus({ ytdlp: false, version: null });
    }
    setChecking(false);
  }
  useEffect(() => {
    void check();
  }, []);
  return { status, checking, check };
}

/** The line that says how to get yt-dlp, for this computer's system. */
export function installLine(): string {
  if (libraryInfo.platform === "win32") return "winget install yt-dlp";
  if (libraryInfo.platform === "darwin") return "brew install yt-dlp";
  return "brew install yt-dlp on a Mac, winget install yt-dlp on Windows";
}

export function YtdlpLine({ ytdlp, className }: { ytdlp: ReturnType<typeof useYtdlp>; className?: string }) {
  const { status, checking, check } = ytdlp;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs", className)}>
      {status == null ? (
        <span className="text-cream/50">Checking for yt-dlp…</span>
      ) : status.ytdlp ? (
        <span className="text-cream/60">yt-dlp {status.version} is installed. It finds videos and their most-replayed moments.</span>
      ) : (
        <span className="text-cream/70">
          YouTube stations need yt-dlp to find videos. Install it with <code className="rounded bg-black/40 px-1.5 py-0.5 text-cream">{installLine()}</code>, then check again.
        </span>
      )}
      <button type="button" className="rounded-md bg-cream/10 px-2 py-1 text-cream hover:bg-cream/20 disabled:opacity-40" disabled={checking} onClick={() => void check()}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/** How a kind of station lands a tune-in, unless changed: uploads and long videos on the clock, compilations on their best moments, playlists near the start. */
function defaultSurf(key: string): SurfMode {
  if (key === "compilations" || key === "fan-compilations") return "peaks";
  if (key.startsWith("playlist:")) return "start";
  return "clock";
}

function stationName(channel: string, kind: Kind): string {
  if (kind.key === "uploads") return channel;
  if (kind.key === "fan-compilations") return `${channel} compilations`;
  return `${channel} · ${kind.label}`;
}

const SURF_LABELS: { value: SurfMode; label: string }[] = [
  { value: "clock", label: "Clock" },
  { value: "start", label: "Start of video" },
  { value: "peaks", label: "Top moments" },
];

const card = "rounded-lg bg-cream/5 p-3";
const small = "rounded-md bg-cream/10 px-2.5 py-1 text-xs text-cream hover:bg-cream/20 disabled:opacity-40";
const chip = "rounded-md bg-cream/10 px-2.5 py-1 text-xs text-cream hover:bg-accent hover:text-room disabled:opacity-40";

function Busy({ text }: { text: string }) {
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-cream/60" role="status">
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-cream/25 border-t-accent" />
      {text}
    </p>
  );
}

type AdderProps = {
  channels: Channel[];
  dispatch: (action: ParlorAction) => void;
  className?: string;
};

export function YoutubeAdder({ channels, dispatch, className }: AdderProps) {
  const ytdlp = useYtdlp();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [picked, setPicked] = useState<ChannelInfo | null>(null);
  /** Kind key → its surf mode, for the kinds that are ticked. */
  const [chosen, setChosen] = useState<Map<string, SurfMode>>(new Map());
  /** Side channels, and whose they are: they stay listed while one of them is being added. */
  const [sides, setSides] = useState<{ of: string; list: Side[] } | null>(null);

  async function step<T>(label: string, work: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError(null);
    try {
      return await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function find(text: string) {
    const q = text.trim();
    if (!q) return;
    setQuery(q);
    setPicked(null);
    setSides(null);
    setNote(null);
    const result = await step(`Looking for ${q} on YouTube…`, () => ask<{ channels: Found[] }>(`/api/youtube/find?q=${encodeURIComponent(q)}`));
    if (result) setFound(result.channels);
  }

  async function open(url: string, keepSides = false): Promise<ChannelInfo | null> {
    if (!keepSides) setSides(null);
    setNote(null);
    const info = await step("Reading the channel: its videos and playlists…", () => ask<ChannelInfo>(`/api/youtube/channel?url=${encodeURIComponent(url)}`));
    if (!info) return null;
    setPicked(info);
    setChosen(new Map([["uploads", defaultSurf("uploads")]]));
    return info;
  }

  async function findSides(info: ChannelInfo) {
    const result = await step(`Looking for ${info.name}'s other channels…`, () =>
      ask<{ channels: Side[] }>(`/api/youtube/side?url=${encodeURIComponent(info.url)}&name=${encodeURIComponent(info.name)}`),
    );
    if (result) setSides({ of: info.name, list: result.channels });
  }

  /**
   * Read each plan's videos, keep them, and make every station in one step (one undo). A plan whose
   * list comes back empty is left out and named. A station already made from the same list is not made twice.
   */
  async function make(plans: Plan[]) {
    const have = new Set(channels.map((item) => item.youtube?.url).filter(Boolean));
    const fresh = plans.filter((plan) => !have.has(plan.url));
    const already = plans.filter((plan) => have.has(plan.url)).map((plan) => plan.name);
    if (fresh.length === 0) {
      setNote(`You already have ${already.join(", ")}.`);
      return;
    }
    const made = await step(`Reading ${fresh.length === 1 ? "the videos" : `${fresh.length} lists of videos`} from YouTube…`, async () => {
      const lists: { plan: Plan; videos: Video[] }[] = [];
      // Two at a time: yt-dlp is one process per list, and YouTube is kinder to a few than to many.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, fresh.length) }, async () => {
          while (next < fresh.length) {
            const plan = fresh[next++]!;
            const list = await ask<{ videos: Video[] }>(`/api/youtube/list?url=${encodeURIComponent(plan.url)}`);
            lists.push({ plan, videos: list.videos });
          }
        }),
      );
      lists.sort((a, b) => fresh.indexOf(a.plan) - fresh.indexOf(b.plan));
      const all = new Map<string, Video>();
      for (const list of lists) for (const video of list.videos) all.set(video.id, video);
      await rememberYoutube([...all.values()]);
      return lists;
    });
    if (!made) return;
    const now = Date.now();
    const usable = made.filter((list) => list.videos.length > 0);
    const empty = made.filter((list) => list.videos.length === 0).map((list) => list.plan.name);
    if (usable.length > 0) {
      dispatch({
        type: "create-many",
        now,
        label: usable.length === 1 ? `Made ${usable[0]!.plan.name}` : `Made ${usable.length} YouTube stations`,
        items: usable.map(({ plan, videos }) => ({
          id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `ch-${now}-${plan.kind}`,
          name: plan.name,
          mode: "shuffle",
          mediaIds: videos.map((video) => youtubeMediaId(video.id)),
          youtube: { channel: plan.channel, channelUrl: plan.channelUrl, kind: plan.kind, url: plan.url },
          ...(plan.surf !== "clock" ? { surf: plan.surf } : {}),
        })),
      });
    }
    setNote(
      [
        usable.length > 0 ? `Made ${usable.map((list) => `${list.plan.name} (${list.videos.length})`).join(", ")}.` : "",
        empty.length > 0 ? `Nothing found for ${empty.join(", ")}, so ${empty.length === 1 ? "it was" : "they were"} left out.` : "",
        already.length > 0 ? `Already had ${already.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function plansFor(info: ChannelInfo, picks: Map<string, SurfMode>): Plan[] {
    return info.kinds
      .filter((kind) => picks.has(kind.key))
      .map((kind) => ({ name: stationName(info.name, kind), kind: kind.key, url: kind.url, surf: picks.get(kind.key) ?? defaultSurf(kind.key), channel: info.name, channelUrl: info.url }));
  }

  // Starters: whole flows for a few creators, no questions asked.
  async function jerma() {
    const channelUrl = "https://www.youtube.com/@Jerma985";
    await make([
      { name: "Jerma985", kind: "uploads", url: `${channelUrl}/videos`, surf: "clock", channel: "Jerma985", channelUrl },
      { name: "Jerma compilations", kind: "fan-compilations", url: "ytsearch40:jerma985 compilation", surf: "peaks", channel: "Jerma985", channelUrl },
      { name: "Jerma infomercials", kind: "search:infomercial", url: "ytsearch40:jerma985 infomercial", surf: "peaks", channel: "Jerma985", channelUrl },
    ]);
  }
  async function pokelawls() {
    const info = await open("https://www.youtube.com/@Pokelawls");
    if (!info) return;
    const picks = new Map<string, SurfMode>();
    for (const key of ["uploads", "long", "fan-compilations"]) if (info.kinds.some((kind) => kind.key === key)) picks.set(key, defaultSurf(key));
    setChosen(picks);
    await make(plansFor(info, picks));
  }

  if (ytdlp.status && !ytdlp.status.ytdlp) {
    return (
      <div className={className}>
        <p className="text-sm text-cream/70">YouTube</p>
        <YtdlpLine ytdlp={ytdlp} className="mt-2" />
      </div>
    );
  }

  const disabled = busy != null;
  const picks = picked ? plansFor(picked, chosen) : [];

  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm text-cream/70">YouTube</p>
        <span className="text-xs text-cream/45">Stations of a YouTuber's videos, played in YouTube's own player. Nothing is downloaded.</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-cream/55">Starters</span>
        <button type="button" className={chip} disabled={disabled} onClick={() => void jerma()} title="Jerma985's uploads, compilations of him, and his infomercials">
          Jerma985
        </button>
        <button type="button" className={chip} disabled={disabled} onClick={() => void find("Corridor Digital")} title="Find Corridor Digital, then pick its kinds and side channels">
          Corridor Digital
        </button>
        <button type="button" className={chip} disabled={disabled} onClick={() => void pokelawls()} title="Pokelawls' uploads, long videos, and compilations across YouTube">
          Pokelawls
        </button>
      </div>

      <form
        className="mt-2 flex gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void find(query);
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="YouTuber name, @handle or channel link"
          className="min-w-0 flex-1 rounded-lg border border-cream/15 bg-room px-3 py-2 text-sm text-cream outline-none focus-visible:outline-2 focus-visible:outline-accent"
        />
        <button type="submit" className="rounded-lg bg-cream/10 px-3 text-sm text-cream hover:bg-cream/20 disabled:opacity-40" disabled={disabled || !query.trim()}>
          Find
        </button>
      </form>

      {busy ? <Busy text={busy} /> : null}
      {error ? <p className="mt-2 text-xs text-accent">{error}</p> : null}
      {note ? <p className="mt-2 text-xs text-cream/70">{note}</p> : null}

      {found && !picked ? (
        <div className={cn(card, "mt-2")}>
          {found.length === 0 ? (
            <p className="text-xs text-cream/55">No channels found for that. Try their @handle, or paste the channel's link.</p>
          ) : (
            <ul className="space-y-1">
              {found.map((item) => (
                <li key={item.url}>
                  <button type="button" disabled={disabled} onClick={() => void open(item.url)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-cream/10 disabled:opacity-50">
                    <span className="text-sm text-cream">{item.name}</span>
                    <span className="ml-2 text-xs text-cream/45">
                      {item.handle ?? ""}
                      {item.count != null ? ` · ${item.count} of the results` : ""}
                    </span>
                    <span className="block truncate text-xs text-cream/50">{item.sample.join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {picked ? (
        <div className={cn(card, "mt-2")}>
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm text-cream">{picked.name}</p>
            <span className="text-xs text-cream/45">{picked.handle ?? ""}</span>
            <button type="button" className="ml-auto text-xs text-cream/55 underline hover:text-cream" onClick={() => setPicked(null)}>
              {found ? "Back to the results" : "Close"}
            </button>
          </div>
          <p className="mt-1 text-xs text-cream/55">Pick the stations to make. Each is shuffled; the menu beside it says how a tune-in lands.</p>
          <ul className="mt-2 space-y-1">
            {picked.kinds.map((kind) => {
              const on = chosen.has(kind.key);
              return (
                <li key={kind.key} className="flex items-center gap-2 text-sm">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setChosen((map) => {
                          const next = new Map(map);
                          if (on) next.delete(kind.key);
                          else next.set(kind.key, defaultSurf(kind.key));
                          return next;
                        })
                      }
                      className="accent-accent"
                    />
                    <span className="min-w-0 truncate">
                      {kind.label}
                      <span className="text-cream/45">
                        {kind.count != null ? ` · ${kind.count}` : ""}
                        {kind.note ? ` · ${kind.note}` : ""}
                      </span>
                    </span>
                  </label>
                  <select
                    aria-label={`How a tune-in to ${kind.label} lands`}
                    disabled={!on}
                    value={chosen.get(kind.key) ?? defaultSurf(kind.key)}
                    onChange={(event) => setChosen((map) => new Map(map).set(kind.key, event.target.value as SurfMode))}
                    className="shrink-0 rounded-md bg-black/60 px-2 py-1 text-xs text-cream outline-1 outline-cream/20 disabled:opacity-40"
                  >
                    {SURF_LABELS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-room hover:opacity-90 disabled:opacity-40"
              disabled={disabled || picks.length === 0}
              onClick={async () => {
                await make(picks);
                if (sides == null || sides.of !== picked.name) await findSides(picked);
              }}
            >
              Make {picks.length} {picks.length === 1 ? "station" : "stations"}
            </button>
            <button type="button" className={small} disabled={disabled} onClick={() => void findSides(picked)}>
              Find side channels
            </button>
          </div>

          {sides ? (
            <div className="mt-3 border-t border-screen pt-3">
              <p className="text-xs text-cream/55">Side channels · other outlets that look like {sides.of}'s</p>
              {sides.list.length === 0 ? (
                <p className="mt-1 text-xs text-cream/45">No other channels found.</p>
              ) : (
                <ul className="mt-1 grid gap-1.5 sm:grid-cols-2">
                  {sides.list.map((item) => (
                    <li key={item.url} className="flex items-start gap-2 rounded-md bg-cream/5 px-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-cream">{item.name}</p>
                        <p className="truncate text-xs text-cream/45">{item.reasons.join(", ")}</p>
                        <p className="truncate text-xs text-cream/50">{item.sample.join(" · ")}</p>
                      </div>
                      <button type="button" className={small} disabled={disabled || item.name === picked.name} onClick={() => void open(item.url, true)}>
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
