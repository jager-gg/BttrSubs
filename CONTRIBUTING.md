# Contributing

## Setup

```bash
npm ci
cp .env.example .env   # set CONFIG_SECRET, PUBLIC_BASE_URL and ADMIN_PASSWORD
npm run dev            # http://localhost:7000/configure
```

Sync needs `ffmpeg` and `ffprobe` on your PATH, and an AIOStreams install URL from an instance in `OWN_AIOSTREAMS` or `ALLOWED_AIOSTREAMS`.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

The same checks run on every push and pull request, and the tests also run during the Docker build.

For changes to sync or matching, run the replay check against a server's cache as well. It shows which past plays a change would decide differently:

```bash
REPLAY_HOST=<ssh host> npm run replay
```

See `scripts/replay.ts` and [docs/how-it-works.md](docs/how-it-works.md).

A change to how subtitles are timed also needs, on a replay cache:

```bash
npm run bench        # made-up plays whose right timing is known: 0 failing
npm run score        # past plays timed again: not lower (docs/scoring.md)
npm run negatives    # every file against every subtitle that isn't its own: none newly served as synced
```

## Layout

| Path | What it does |
|---|---|
| `src/server.ts` | Start-up: checks the required settings, starts the server |
| `src/app.ts` | Routes: manifest, subtitle lists, downloads, dashboard |
| `src/stremio.ts`, `src/types.ts` | What a subtitles request asks for, and the shapes the sources share |
| `src/access.ts` | Sign-in for the configure page and dashboard, rate limits |
| `src/profile.ts` | Per-link settings, encrypted into the link |
| `src/configure.ts`, `src/page.ts` | The configure page: checks and HTML |
| `src/sources.ts`, `src/subsource.ts`, `src/downloads.ts` | SubSource, SubDL, OpenSubtitles and other addons; downloads and unpacking |
| `src/wyzie.ts`, `src/thesubtitledb.ts`, `src/gestdown.ts`, `src/subtitlecat.ts`, `src/animetosho.ts` | The other sources: Wyzie Subs, TheSubtitleDB, Gestdown (Addic7ed's TV subtitles), Subtitle Cat and Anime Tosho (dub captions and signs from anime releases' own tracks) |
| `src/kept.ts` | Subtitles kept on the server (`CAPTIONS_DIR`) |
| `src/cinemeta.ts` | A title's name, year, TVDB id, genres and country from Cinemeta, shared by the sources (and whether it is anime) |
| `src/ids.ts`, `src/animelists.ts`, `src/anidb.ts`, `src/animetitles.ts` | Anime: ids other than IMDb, episode numbering, and a show's seasons by their own titles (the season map) |
| `src/matching.ts`, `src/quality.ts` | Episode matching and ranking |
| `src/sync.ts`, `src/align.ts` | Retiming a subtitle to the playing file |
| `src/mkv.ts`, `src/mp4.ts`, `src/audiowindow.ts`, `src/oshash.ts` | Reading the playing file: its subtitle tracks' timing, stretches of its audio, its hash |
| `src/vad.ts`, `src/vad-worker.ts`, `src/turns.ts` | Speech in the audio (Silero VAD), and whose turn it is to hear a file |
| `src/reads.ts`, `src/net.ts`, `src/viewers.ts` | Where a file may be read from, pausing when its host refuses, the daily read limit; fetching addresses a third party gave |
| `src/signs.ts`, `src/signsjob.ts` | Signs & songs with English Dub, and the playing file's own subtitle style |
| `src/srt.ts`, `src/clean.ts`, `src/text.ts`, `src/langcodes.ts` | Formats sent, sound descriptions taken out, text encodings, language codes |
| `src/cache.ts`, `src/cleanup.ts`, `src/logs.ts` | The on-disk cache, what leaves it, and the log files |
| `src/stats.ts`, `src/dashboardData.ts`, `src/statsPage.ts`, `src/diagnostics.ts` | The dashboard: its numbers, the data its page draws, the page, and Copy diagnostics |
| `src/config.ts`, `src/settings.ts`, `src/updates.ts`, `src/debugMark.ts` | Settings from `.env`, the ones changed on the dashboard over them, what's new and the update check, marking test plays |
| `src/ui.ts`, `assets/ui/` | What the pages share, and their styles, scripts and fonts |
| `test/` | Vitest tests |
| `scripts/` | Replay check, sync score (`npm run score`, see [docs/scoring.md](docs/scoring.md)), the cross check of subtitles that aren't the file's (`npm run negatives`, same page), sync benchmark (`npm run bench`, see [docs/benchmark.md](docs/benchmark.md)) and speech-detector evaluation |

## Issues and pull requests

- Bugs and ideas go in the issue forms. A security problem goes in a private advisory instead (see [SECURITY.md](SECURITY.md)).
- A pull request runs the tests on GitHub and needs them green. Keep one change per pull request, and say in it what changes for people running it.
- Never paste an install URL or key in an issue or pull request: it opens that configuration.

## Releasing

1. Set the new version in `package.json` (`npm version 1.1.0 --no-git-tag-version` sets the lock file too), following [semantic versioning](https://semver.org): a major version when upgrading needs a step.
2. Add its section to `CHANGELOG.md` (`## [1.1.0]`): what changed for people running it, and any upgrade step.
3. Commit, then tag and push the tag: `git tag v1.1.0 && git push origin v1.1.0`.

The release workflow then runs the checks, publishes the image (`1.1.0`, `1.1`, `1` and `latest`; a pre-release such as `v1.1.0-rc.1` gets only its own tag) for amd64 and arm64, and makes a GitHub release from the changelog section. It stops if the tag and `package.json` disagree, or the changelog has no section for the version.

## Rules

- Never put API keys, passwords or real install URLs in code, tests or logs. Tests use made-up values.
- Anything a user or a third party controls (subtitle files, addon URLs, archives) is untrusted: keep fetches to public https hosts (`src/net.ts`) and keep size limits in place.
- Add or update tests for any change in behaviour.
- When the sync method changes in a way that makes old results wrong, bump `SYNC_VERSION` in `src/sync.ts`.
- Work on a branch and open a pull request against `main`.
- Contributions are licensed under the project's license, [AGPL-3.0](LICENSE).
