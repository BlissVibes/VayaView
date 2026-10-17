# VayaView

Your own TV channels, made from your own films and shows. Every channel runs on a clock, the way
broadcast TV does: tune in and you join whatever is on, part-way through. A TV guide shows every
channel and what each is playing, with the picture still running above it.

Desktop app for Windows and macOS (Electron). Plays your files with the help of ffmpeg.

## Using it

- **Install:** download `VayaView-win32-x64.zip` from the latest release, unzip it to a folder such as
  `D:\SelfTV\VayaView`, and run `VayaView.exe`. Your saved data lives in a `Data` folder beside that
  folder (for example `D:\SelfTV\Data`).
- **Update:** Settings → Updates → *Update to …*. The new version replaces the old one in place, so there
  is only ever one copy.
- **Needs:** ffmpeg and ffprobe on the PATH (`winget install Gyan.FFmpeg`). Genres, franchises and directors
  come from TMDB with a token built into the app; your own token (Settings › Library) replaces it if you like.

### On a Mac

- **Install:** download `VayaView-darwin-arm64.zip` (Apple Silicon) or `VayaView-darwin-x64.zip` (Intel)
  from the latest release, unzip it, and drag `VayaView.app` into Applications.
- **First open:** the app is not signed by Apple, so the first time, **right-click VayaView › Open**, then
  Open again in the box that appears. (On newer macOS: System Settings › Privacy & Security › *Open Anyway*.)
  After that it opens normally, and updates do not ask again.
- **Needs:** ffmpeg from Homebrew: `brew install ffmpeg`.
- **Your data** lives in `~/Library/Application Support/VayaView/Data`, or in a `Data` folder beside
  `VayaView.app` if you make one there (a portable copy).
- **Update:** the same as on Windows. Keep the app in Applications, or the update cannot replace it.

## Features

- TV guide with live picture, favourites, colour-coded stations, a resizable station column
- Stations from searches, whole shows or single seasons; drag to reorder; undo; backups
- Audio and subtitle track choice; subtitles come on by themselves when the sound is not in English
- Scrub within a programme without changing the schedule, then jump back to live
- Genres, franchises and directors from TMDB (your own free API token, set in Settings)
- Watch on an iPhone over home Wi-Fi, following what the PC is showing (off unless switched on, PIN-paired)
- Themes, custom colours, and your own fonts

## YouTube stations

Stations can also be made of a YouTuber's videos: Edit stations › New station › **YouTube**. Type a
name, @handle or channel link, pick the creator, then tick the kinds of station their videos make
(everything they upload, their long videos, compilations other people cut from them, each playlist).
One click makes them all; their side channels (vlogs, music, clips) are offered after. Jerma985,
Corridor Digital and Pokelawls are there as one-click starters.

- The videos play in **YouTube's own player**, inside the picture. Nothing is downloaded, and they
  need the Internet. YouTube stations play on the PC only, not on a phone.
- Some videos are not allowed to play outside youtube.com. When one comes up, the picture offers to
  **play it anyway through yt-dlp** (streamed, not saved; about 10 seconds to start), or skips to the
  station's next video. Unanswered, it skips by itself after 10 seconds.
- Finding videos (and each video's most-replayed moments) needs **yt-dlp** on the PC:
  `brew install yt-dlp` on a Mac, `winget install yt-dlp` on Windows. Settings › Surfing says
  whether it is there.
- **Surf modes** (in each station's editor) say where a tune-in lands: *Clock* (wherever the station
  is, like broadcast), *Start of video* (a random point in the first tenth), or *Top moments* (one of
  YouTube's most-replayed peaks, joined 15–30 s before it). **S** jumps to another video of the
  station at its surf point. *Surf the tube* spreads a station into one channel per video.
- **Between channel flips** (Settings › Surfing): stations keep running while you are away
  (the default), or YouTube stations (or every station) wait and resume where you left them, for up
  to six hours. Back to Live always joins the station's clock.

## Building

```bash
npm install
npm run release
```

`npm run dev` runs the interface in a browser for development; `npm run app` runs the real Electron
shell against the built interface. `npm run package` builds the app for the system you are on:
`VayaView\VayaView.exe` on Windows, `releases/mac/VayaView-darwin-{arm64,x64}/VayaView.app` on a Mac.
`npm run release` also zips it into `releases/` for a GitHub release (on a Mac the apps are ad-hoc
signed and zipped with `ditto`, so the bundle's symlinks survive).

Building on a Mac needs Node 22 or newer and ffmpeg (`brew install ffmpeg`); nothing else. The tests
run with `npm test`.

To ship a TMDB token inside the app (so users get genres without making an account), save one as
`server/tmdb-key.json` (copy `server/tmdb-key.example.json`) or set `VAYAVIEW_TMDB_TOKEN` when packaging.
The file is ignored by git. The Mac workflow reads it from a repository secret named `TMDB_TOKEN`.

The Mac app can also be built by GitHub when releasing from Windows: when a release is published,
`.github/workflows/mac-release.yml` builds `VayaView.app` on a Mac runner (`node scripts/package.mjs --mac`),
ad-hoc signs it, and attaches `VayaView-darwin-arm64.zip` and `VayaView-darwin-x64.zip` to the release.
It can also be run by hand from the Actions tab with a release tag.
