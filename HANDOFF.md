# Parlor — handoff

Personal television. A channel is a clock plus a locked lineup, not a stream that runs in the background. This preview proves the schedule, the guide, and the smart search. It does **not** read the user's disk and it does **not** play their files. Replace the stand-in picture with libmpv. Do not throw the schedule away.

## What already works

- `src/lib/schedule/engine.ts` — pure. `onNow(channel, library, missing, nowMs)` joins mid-film. Shuffle is seeded per cycle (`shuffleSeed:cycleIndex`), so reopening the app does not reshuffle. A missing file keeps its duration; skipping it would desync the station. Unknown ids and non-positive durations are omitted.
- Guide is the same walk, two hours ahead (`guideFrom`). Clicking a row tunes **live**. It does not start a future film early.
- Smart search is `searchLibrary` in `src/lib/library/match.ts`. It matches title, collection, director, genre, and keyword. If the query hits a collection name, **every** film in that collection is included, including titles that do not contain the words (`Age of Rust`, `Workshop Blueprints` → Iron Harvest).
- Factory stations in `src/lib/library/factory.ts` are built with that search. `FACTORY_ANCHOR` is 13 Oct 2026, 11:05 UTC, so a join that day lands mid *Age of Rust* — on the Iron Harvest station, under a title that does not contain the channel name. The cycle is about 14 hours, so a later visit is simply further along. New stations anchor at the moment they are created and start at the top.
- Lineup edits that change order or membership re-anchor to now, on purpose, so the picture does not leap to a random minute.
- `blueprints` and `milk-glass` start marked not-on-disk. The slate holds the slot. Toggle that in the lineup's library list.
- State persists in `localStorage` under `parlor.v2`.

Tests (node, no DOM):

```bash
node --experimental-strip-types --test \
  src/lib/schedule/engine.test.ts \
  src/lib/library/filename.test.ts \
  src/lib/library/match.test.ts \
  src/lib/library/reducer.test.ts \
  src/lib/player/seam.test.ts
```

## How a file becomes "horror"

The filename cannot do it. `Midsommar.2019.1080p.BluRay.x264.mkv` yields a title and a year. It does not yield Horror. `parseReleaseName` in `src/lib/library/filename.ts` is only that guess, and it refuses to invent a genre. `Transformers.Dark.of.the.Moon.2011.mkv` is a title. The franchise is a metadata field.

On the desktop port, once per new file:

1. Probe duration, video codec, audio codec, and subtitle tracks (ffprobe). Prefer the probe's duration over a database runtime. Cache it. This is the only heavy scan, and it is not playback.
2. Parse the filename into title + year.
3. Match that guess once against a metadata source, then cache forever:
   - TMDB (movies): genres, keywords, **collection** (this is the franchise id — all Transformers titles share one), director, runtime, artwork.
   - TVDb / TMDB TV for series episodes. A "series channel" is an ordered list of episodes, same engine.
   - Or read an existing Jellyfin / Kodi / Plex NFO or database if they already have one. No second lookup.
4. Ambiguous hits (`The Thing` 1982 vs 2011) ask once when the year is missing. Store the chosen provider id on the film (`metadataId`) so a rescan does not ask again.
5. Unmatched files go to a pile. The user types the real title or sets genre by hand. Manual tags win over guessed ones.
6. Playback never calls the network. Channel rules run on the cache.

Genre lists are short and opinionated (Horror, Drama, …). "Coming of age" is usually a **keyword**, not a genre. Search both, which this preview already does. A horror channel is `genre includes Horror`. A Transformers channel is `collection name matches`, not a substring hunt that misses a retitled entry.

Do not classify genre by watching pixels. It is slower and worse than a database.

## Player

`src/lib/player/seam.ts` — `playRequestFor` is the contract: one file, one offset, or a missing slate.

- Desktop: Tauri (or a thin native shell) + **libmpv**, `hwdec=auto-safe`. Seek to `offsetMs` on tune. One process. Channel change loads a different file. Do not keep other stations warm.
- HTML video is the wrong default. Real libraries are MKV / HEVC / AC3 / DTS / ASS / PGS. mpv plays those. If decode falls back to software on 4K HEVC, say so — that is the case that melts a CPU.
- When real frames are showing, hide the title card after a few seconds. The preview keeps it visible because the picture is fake.
- Preload the next file's header near the end of the slot. Do not decode it until the boundary.

## Streaming mode, later

Not in this preview. Do not build a standing ffmpeg per channel.

- A switch, default off. Off means nothing listens on the network.
- On, and idle: a small listener. Almost free.
- A TV tunes in: open **one** session at the same `offsetMs` the clock already computed (`streamSessionFor`).
- Direct copy when the client can take the codec. Transcode only that session, hardware encoder if present (NVENC / QSV / AMF). Audio-only convert (DTS → AAC, video copied) is the cheap middle.
- Tear the session down when the last remote viewer leaves.
- Two TVs on the same station can share one transcode later. Not required first.
- Outside-the-house access (accounts, relay, upload) is the actual Plex-shaped step. TVs on the LAN do not need it.

## Resource budget

| Situation | Cost |
|---|---|
| App open, one station | One hardware decode, about like VLC |
| Other stations | A few kilobytes of lineup math. Not playing. |
| Streaming switch on, nobody connected | Idle listener |
| Remote direct-play | Disk read + LAN |
| Remote transcode | One encode for that viewer |
| Every channel encoding in the background | Do not build this |

## Do not

- Re-roll shuffle on launch.
- Skip a missing file's runtime.
- Transcode or probe during ordinary channel changes.
- Put schedule math inside the player.
- Add accounts or a database for this local app. `localStorage` here; SQLite on the desktop for the library cache.
- Ship the preview catalog (Iron Harvest, Lantern Night, Lena Voss, …) as if it were the user's library. It exists so the search rules are visible. Original titles only — do not replace them with real franchise names in the demo.
