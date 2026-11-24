# Changelog

Each version is a tag (`v1.0.0`) with an image on GitHub's registry (`ghcr.io/jager-gg/bttrsubs:1.0.0`, `:1.0`, `:1` and `:latest`). Versions follow [semantic versioning](https://semver.org): a major version can need a step when upgrading, and its section says which.

## [1.2.1]

Fixed: subtitles timed by the audio on a file whose own subtitle track is far off its voices, and Remove sound descriptions in captions that name every speaker. Nothing to do when upgrading: subtitles are timed again the next time they are played.

- **A file whose own subtitle track is far off its voices:** a subtitle timed by the audio there keeps that timing. It was then pulled toward the file's own lines, up to 0.9 s a line, and in the list a subtitle that fit those lines (and so was off the voices with them) could take its place.
- **Remove sound descriptions in captions that name every speaker** ("Mary: …", "Guard #2: …"): those names go too, and so do the sounds in parentheses at the start or end of a speaker's line. Every other subtitle is cleaned as before.

## [1.2.0]

New: two more places to find anime subtitles, and a bigger Style step. Fixed: a subtitle that holds two episodes. Nothing to do when upgrading. A configuration saved with the new style options doesn't open in 1.1.0, so going back means making it again.

- **TsukiHime and aninzb as sources:** the subtitle tracks anime releases carry, in every language you pick, and the dub's captions where a release has them. No key; both are on unless you turn them off.
- **A pace for each service:** requests to a service that limits how often one address may ask it wait their turn, and stop for as long as the service says when it answers that it was asked too often.
- **Style, more to change:** italics, letter spacing, the top or the bottom of the picture, how solid the box is, and any font by its name.
- **A style for one language:** a look can apply to one language only, beside the looks for everything, a series or one title.
- **Your file's subtitle style for every language,** where it was English only.
- **The Style step redrawn:** the preview stays in view with the looks under it, a light and a dark scene to check a look against, a line of your own to try, and Reset in the heading.
- **A subtitle that holds two episodes** is timed by the part that is the playing file's, where it was sent as it came.

## [1.1.0]

New: a check of a file's own subtitle track against its voices, timing that starts before the slowest source answers, and more languages to pick in Setup. Fixed: timing changes placed in too short a pause, lines shown together, and files and packs that weren't found or opened. Nothing to do when upgrading: subtitles are timed again the next time they are played.

- **A timing change in the right pause:** where a subtitle's shift changes mid-episode and the later lines move earlier, the change now sits in a pause long enough for it. In a shorter one, the lines after it landed on the lines before it and ran late for a scene.
- **No two lines on screen that weren't written so:** a line that would stay up into the next one after retiming ends where the next begins.
- **A file whose own subtitle track is off its voices:** a subtitle made for the playing release is checked against a little of the audio when the file's track moves it by a second or more, and is served as it came when that is what the voices say.
- **English Dub on a subtitle that steps:** the voices are heard in each stretch of the timing, so a stretch is no longer moved by another one's voices.
- **"Synced" on the first list more often:** timing starts 2 s before the list's time ends, on what has answered, so one slow source no longer leaves every track saying "Auto sync".
- **Usenet releases:** a release AIOStreams lists under the name of the file inside it, once opened, is found when the player still names it by its NZB.
- **Subtitle packs that list one file name twice** open, where the whole pack failed.
- **Setup's languages:** Portuguese (Brazil) beside Portuguese (Portugal), and Chinese (Simplified and Traditional), Hindi, Swedish, Danish, Finnish, Norwegian, Romanian, Greek, Hebrew, Hungarian, Czech, Ukrainian, Thai and Filipino as chips. Plain Spanish is no longer a chip beside its two kinds; a configuration that has it keeps it.
- **The Errors page** says in its own words when AIOStreams' list didn't hold the playing file, and when a subtitle pack couldn't be opened.

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
