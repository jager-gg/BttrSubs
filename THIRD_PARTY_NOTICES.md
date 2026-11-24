# Third-party notices

BttrSubs is licensed under AGPL-3.0 (see [LICENSE](LICENSE)). It ships, or uses, these from other projects, each under its own license.

| What | Where | License |
|---|---|---|
| [Silero VAD](https://github.com/snakers4/silero-vad), the speech detection model | `assets/silero_vad.onnx` | MIT: [licenses/silero-vad-MIT.txt](licenses/silero-vad-MIT.txt) |
| [Bodoni Moda](https://github.com/indestructible-type/Bodoni), [Big Shoulders](https://github.com/xotypeco/big_shoulders) and [Hanken Grotesk](https://github.com/marcologous/hanken-grotesk), the pages' fonts (Latin subsets) | `assets/ui/fonts/` | SIL OFL 1.1: [licenses/fonts-OFL-1.1.txt](licenses/fonts-OFL-1.1.txt) |
| [FFmpeg](https://ffmpeg.org/download.html) 8.1.2 (`ffmpeg`, `ffprobe`), static builds from [wader/static-ffmpeg](https://github.com/wader/static-ffmpeg) | the Docker image only | GPL-3.0-or-later |
| npm packages: Express, ONNX Runtime for Node, adm-zip, cors, xz-decompress, dotenv, and what they depend on | the Docker image's `node_modules` | MIT; dotenv BSD-2-Clause |
| [anime-offline-database](https://github.com/manami-project/anime-offline-database), anime titles | downloaded by a running server unless `ANIME_TITLES_DATASET` is off; not shipped | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), contents DbCL 1.0 |

FFmpeg is copied into the image unchanged and run as a separate program; it is built with `--enable-gpl --enable-version3`. A copy of BttrSubs run from source uses whatever `ffmpeg` is on its machine.

**Source icons.** `assets/sources/` holds a small copy (64 px) of the icon each subtitle source and AIOStreams publishes (its site's favicon or app icon; OpenSubtitles' from its GitHub organisation, github.com/opensubtitles): SubSource, SubDL, Wyzie Subs, OpenSubtitles, TheSubtitleDB, Gestdown, Anime Tosho, TsukiHime, aninzb, Subtitle Cat and AIOStreams; and, for the setup page's question about where you watch, Stremio (from github.com/Stremio/stremio-web), AIOMetadata (from github.com/cedya77/aiometadata) and Jellyfin (from github.com/jellyfin/jellyfin-ux, © the Jellyfin contributors, CC BY-SA 4.0, resized). They are their owners' trademarks, used only to show which service a row is about. They are not covered by this project's license, and BttrSubs is not affiliated with or endorsed by any of them. They are served from this server, so a viewer's browser never calls the sites.

BttrSubs is built for [AIOStreams](https://github.com/Viren070/AIOStreams), a separate project: it talks to it over HTTP and includes none of its code.
