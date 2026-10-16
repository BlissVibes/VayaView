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
- **Needs:** ffmpeg and ffprobe on the PATH (`winget install Gyan.FFmpeg`).

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

## Building

```bash
npm install
npm run release
```

`npm run dev` runs the interface in a browser for development. `npm run package` builds
`VayaView\VayaView.exe`; `npm run release` also zips it into `releases\` for a GitHub release.

The Mac app is built by GitHub, not on Windows: when a release is published,
`.github/workflows/mac-release.yml` builds `VayaView.app` on a Mac runner (`node scripts/package.mjs --mac`),
ad-hoc signs it, and attaches `VayaView-darwin-arm64.zip` and `VayaView-darwin-x64.zip` to the release.
It can also be run by hand from the Actions tab with a release tag.
