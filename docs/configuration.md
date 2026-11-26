# Configuration in detail

The [README](../README.md#settings) lists every setting in one line. This page has the details that don't fit there.

## Server settings

Six settings are read once at start and live only in `.env`: `CONFIG_SECRET`, `PUBLIC_BASE_URL`, `ADMIN_PASSWORD`, `CACHE_DIR`, `CAPTIONS_DIR` and `PORT`. Every other setting can also be changed on the dashboard without a restart.

### `PRIVATE_STREAM_HOSTS`

Hosts on a private network that playing files may be read from, comma-separated, with or without a port (`proxy.lan`, `192.168.1.9:8080`). Use it for a stream proxy on your LAN.

Without it, a file is read only from the public internet and from your own AIOStreams. A stream list can then never point this server at its own network.

### `LIST_BUDGET_MS`

How long a subtitle list may take before it answers with what it has, from 2,000 to 20,000 ms (8,000 unless set).

- A list can take 1.5 s longer (`FILE_WAIT_MS`): on a first play, and when a source used the whole time and the tracks are still being timed to the file. This addon's timeout in AIOStreams (7,000 ms unless changed) must be at least the budget plus 2,500 ms, or AIOStreams drops the whole list. **Add to AIOStreams** on the configure page sets it to the budget plus 3,000 ms (11,000 ms unless either is changed); the page names the same number for adding the addon by hand.
- A longer budget waits for slow sources, and playback starts later.
- A source that answers after the list has been sent isn't wasted. Its subtitles are tried as fallbacks when the listed ones don't fit the file.

### `FILE_WAIT_MS`

How much longer than `LIST_BUDGET_MS` a list may wait for the playing file to be read and its tracks timed, from 1,500 to 10,000 ms (1,500 unless set).

- Only a file that is slow to open uses it (a large remux, a release its host has to fail over from). Sources are never waited for past the budget, and a list is answered as soon as every track's state is known.
- With more of it, a slow file's tracks say whether they synced on the first list, where they said "Auto sync"; on those plays the list takes that much longer.
- A configuration uses only as much of it as its entry's timeout in AIOStreams leaves room for (the budget plus this plus 1,000 ms), so no list is dropped: BttrSubs reads that timeout with the configuration's saved AIOStreams password. Press **Add to AIOStreams** again after setting this; it sets the timeout to the budget plus this plus 1,500 ms. A configuration whose timeout wasn't raised, or that has no password saved, keeps 1,500 ms.

### `MAX_SUBTITLES_PER_LANGUAGE`

The most subtitles a configuration may list for one language, from 1 to 3. A configuration lists one unless it asks for more. Each listed subtitle is downloaded and timed on every play.

### `OPENSUBTITLES_API_KEY`

OpenSubtitles' own API key, one for the whole server. It is free with an account at opensubtitles.com.

- With a key, OpenSubtitles is searched through its own API, which marks machine and AI translations. A configuration with machine translations off then leaves those out.
- Without a key, the OpenSubtitles V3+ addon is searched. It doesn't carry that mark.
- Only searches use the key, and searches have no daily limit. Subtitles are still downloaded through OpenSubtitles V3+.
- Set on the dashboard, it is kept in `settings.json` in the cache folder and used at once. The dashboard says whether a key is set and never shows it.

### `ANIDB_CLIENT` and `ANIDB_CLIENT_VER`

A client registered for AniDB's HTTP API (anidb.net, **Add Project**, then an HTTP API client): its lower-case name and its version number.

With both set, an anime that gets no season map from the Anime Kitsu addon gets one from AniDB's titles. A subtitle named for another season is then not taken for the one playing.

AniDB is asked at most once every 4 s and 100 times a day, each anime at most once in 90 days, and not at all for 36 hours after a refusal. Every request is logged.

### `ANIME_TITLES_DATASET`

With no AniDB client set, an anime that gets no season map from the Anime Kitsu addon gets its seasons' titles from the [anime-offline-database](https://github.com/manami-project/anime-offline-database) (ODbL 1.0). It is downloaded from GitHub the first time a show needs it (about 5 MB) and checked again at most once a day.

Its names are looser than AniDB's, so a name that two seasons share is left out. `off` never downloads it.

### `DAILY_READ_GB`

The most data read from playing files in one UTC day, across everyone. Once it's spent, new files are listed unsynced until the next day. `0` means no limit.

### `LOG_DAYS` and `LOG_MAX_MB`

Log files are kept in the cache volume's `logs` folder, one per UTC day, so the log survives an update. `LOG_DAYS` is how many days are kept, today included; `0` keeps none. `LOG_MAX_MB` caps their total size, and the oldest day is removed first.

## Switches in detail

### Keep the subtitle's own styling

A subtitle uploaded as ASS is sent as ASS, with its styles and positions: lines raised over burned-in text, signs placed where they belong. This is for players that draw ASS. Jellyfin through AIOMetadata passes ASS on to an app that takes it and converts it for one that doesn't.

Off, a subtitle is sent as SRT, which every player shows, unless a style, Signs & songs or the file's own style applies to it: those send ASS either way, with the upload's lines as plain text in that style.

Which look a subtitle gets, first to last: its own styling (with this on, when it has some), then the file's style (**Use your file's subtitle style**), then a style's look, then the plain look. A style's height moves any of them up.

A song set syllable by syllable in a font most players don't have is laid out again in one they have (Arial, Trebuchet MS or Georgia, by the font's kind), so its syllables don't run into each other when the player draws its own font.

### Remove sound descriptions

These are taken out of the text:

- [Bracketed] sounds and speakers.
- A line that is only a (parenthesised) sound, in lower case or capitals.
- Sung lines (♪).
- Speaker names in capitals, such as "JOHN:".
- In captions that name every speaker in normal case ("Mary: …", "Guard #2: …"), those names too, and the (parenthesised) sounds that open or close a speaker's line.

The timing doesn't change, because the sync runs first. A line left empty is dropped. In any other subtitle, names, thoughts and signs written in normal case stay, and parentheses in Arabic always stay.

### Signs & songs with English Dub

For anime. The on-screen text and song lines that a fan release typesets for the episode are shown with English Dub in one ASS script. They come from the release's signs track, or from the signs among its full subtitles, and are timed to the playing file by that release's own dialogue.

The dub's own written-out signs and ♪ placeholders give way to them. Where the dub sings a song in English, the release's lines for it are left out.

It needs a player that shows ASS. The signs' fonts aren't in the file, so a player draws them in a font it has.

### Use your file's subtitle style

Subtitles take the font, size, colours and margins of the subtitles inside the playing file, in place of a style's look. Where that font lacks the letters of a language, the player uses its own. The style is read from the file's English dialogue track and sized to the script it is in, so the subtitles look like the release's own. The file's attached fonts are there for players that load them.

A subtitle that keeps its own styling (**Keep the subtitle's own styling**) keeps it. With English Dub and Signs & songs, the dub's lines then take the dub captions' own dialogue style.

A file with no styled subtitles keeps the plain look, or your style.

### Styles

A style is a look, a height on screen, or both. It applies to all subtitles, anime, series, films or one title, in every language or in one. A style for the track's language comes first, then the most specific place.

- **Look:** Anime streaming, White outline, Bold outline, Yellow, Dark box or Large. Its text and outline colours, font (one of six, or any font named by hand that your player has), size, letter spacing, outline, shadow, bold, italic, box and how solid the box is can be changed, and its lines put at the top or the bottom of the picture. A look applies to subtitles with no styling of their own.
- **Height:** how far up the lines sit, from 1 to 80% of the picture. 15% clears most text burned in at the bottom.

Every subtitle of a title with a style is sent as ASS. With **Keep the subtitle's own styling** on, an upload that has its own styling keeps it and only moves up; off, its lines take the style. Players that draw ASS show the style; others show the words as they are.
