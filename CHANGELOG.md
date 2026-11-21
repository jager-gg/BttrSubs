# Changelog

Each version is a tag (`v1.0.0`) with an image on GitHub's registry (`ghcr.io/jager-gg/bttrsubs:1.0.0`, `:1.0`, `:1` and `:latest`). Versions follow [semantic versioning](https://semver.org): a major version can need a step when upgrading, and its section says which.

## [1.0.0]

The first release of BttrSubs: a self-hosted subtitle addon for AIOStreams that finds subtitles for the episode you're playing and retimes each one to your exact file.

- **Timed to your file:** by the file's own subtitle track where it has one and by its speech where it doesn't. Only the file's header and index are read, and what is read is kept, so a second play costs nothing.
- **Timing that changes mid-file:** a subtitle made for another cut (a broadcast's shorter opening and ad breaks, a different frame rate) is timed in stretches, each with its own shift.
- **The right subtitle:** one written in another language than it is listed under, made for another episode, or fitting nothing in the file is left out; a file that can't be found says so in one line instead of sending untimed subtitles.
- **One subtitle per language,** or two or three if you ask; the others stand behind the listed one and take its place when it can't be synced.
- **Sources:** SubSource, SubDL and Wyzie Subs with your keys; OpenSubtitles, TheSubtitleDB, Gestdown and Anime Tosho without one; Subtitle Cat if you turn it on; any subtitle addon you add; and a folder of your own subtitles on the server (`CAPTIONS_DIR`).
- **English Dub for anime:** the dub's captions are listed first for a file with English audio, with a release's signs & songs in the same track if you turn that on.
- **Anime numbering:** long shows numbered straight through, seasons filed under their own name, and season packs are matched to the episode playing, from the public anime lists and, as an option, AniDB.
- **Style:** keep a subtitle's own styling, pick a look, use the style of the subtitles inside your file, or remove sound descriptions.
- **A configure page** that saves everything into your install URL, encrypted, and can add it to your AIOStreams for you.
- **A dashboard** at `/dashboard`: whether it's doing its job this week, each API key against its limits, the activity and errors with how every sync was made, each configuration (rename, pause, configure, delete, copy its install URL), and server settings that change without a restart. It opens as an app from a phone's Home Screen.
- **Logs and diagnostics:** the server's log is kept a week in the cache volume, and Copy diagnostics copies a request in full for a bug report.
- **Updates:** the sidebar says what's new in the running version and when a newer one is out, from a once-a-day check of GitHub's releases that sends nothing about the server (`UPDATE_CHECK` turns it off).
- **Debug marking** (`dist/debugMark.js`), so testing stays out of the dashboard's numbers.
- **Images for amd64 and arm64** on GitHub's registry, so installing and updating need no build, and image updaters such as Watchtower work.
