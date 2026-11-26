# How BttrSubs finds the file you're playing

To time a subtitle, BttrSubs has to read the file you picked. A player tells a subtitle addon only the file's name and size, so BttrSubs asks AIOStreams for the title's streams again and opens the one with that name.

This page explains why setup asks for your AIOStreams address, UUID and password, and what each kind of app needs.

## Why one stream list isn't enough

Two requests for the same title can get different lists from AIOStreams:

- With dynamic fetching, AIOStreams answers as soon as its condition is met. An addon that was in time for one request can miss the next.
- When a release fails, AIOStreams fails over to another one. The player still reports the first file's name.

So the list BttrSubs gets can lack the file your player got. BttrSubs needs the list your player chose from, and where that list is kept depends on the app.

## Where each app's list is kept

**Stremio, and apps that use Stremio addons.** AIOStreams keeps a finished list under the whole request: the viewer's address and the install URL exactly as it was written, encrypted password included. AIOStreams encrypts the password again every time it writes an install URL, so two install URLs of one configuration are two different keys. Only a request made with your app's own install URL gets your app's list.

When you link your Stremio account in AIOStreams (**Save & Install → Linked accounts → Link an account → Stremio**, then **Push**), AIOStreams stores the install URL it put into that account and pushes the same one again later. BttrSubs reads that URL with your password, so it stays correct when you change your AIOStreams configuration.

Without a linked account, BttrSubs asks with an install URL of its own. Most plays still sync. A file is missed when the two lists differ, usually after a failover.

**The AIOStreams app, and Jellyfin apps connected to AIOStreams.** These sign in to AIOStreams' own Jellyfin server and have no install URL. That server keeps a title's versions under your configuration for a few minutes, whichever device asks. BttrSubs signs in the same way an app does and takes the file from those versions. Titles are found by their IMDb id, and anime by their Kitsu id.

**Jellyfin apps connected to AIOMetadata.** AIOMetadata asks AIOStreams with the install URL saved in it (**Jellyfin → Make titles play → Stream addon for everyone**). Paste that URL into the setup step, up to three of them.

## The order of a lookup

1. BttrSubs asks with its own install URL.
2. If that list lacks the file, it asks with each linked app's URL.
3. Then with each pasted URL.
4. Then it asks AIOStreams' Jellyfin server.

An anime episode asked for by its IMDb id (`tt…:1:27`) has a second id, the one the anime lists give it (`kitsu:…:27`), and AIOStreams keeps a list for each id it is asked with: a search by one isn't the search by the other. A Jellyfin server that lists anime by Kitsu ids shows that list, and can send the subtitle request with the IMDb id (subtitle addons answer those), with nothing that says which id the list was asked for by. So at each step, a list that lacks the file is asked for again by the other id before the next step.

When the list by the first id is slow, the other id is asked alongside it, and the file is taken from whichever list has it first.

It stops at the first one that has the file. A file it can't find isn't synced, rather than synced to another file.

## AIOStreams' limit on stream lists

AIOStreams limits how many stream lists one address may ask for (ten in fifteen seconds by default). BttrSubs reads the limit from AIOStreams' answers and stays within it: lookups wait for the next window, identical lookups share one request, and the playing file comes before an episode asked ahead. There is nothing to set.

## The pipeline cache

If you run your own AIOStreams, set **Pipeline cache TTL** (`PIPELINE_CACHE_TTL`) to `60` in its admin settings. It needs no restart.

With the cache on, a lookup made with a linked Stremio's URL or a pasted AIOMetadata URL is answered from memory with the exact list that player chose from, in tens of milliseconds. Without it, AIOStreams asks every addon again, which takes one to three seconds and can miss the file again. BttrSubs' repeated lookups for one play are answered from memory too, which is lighter on AIOStreams, its addons and your debrid service.

Its cost is memory for the lists asked in the last minute (at most `PIPELINE_CACHE_MAX_SIZE`, 1000 by default). A stream list reopened within that minute shows the same results without asking a failed addon again.

The AIOStreams app and Jellyfin apps connected to AIOStreams don't use this cache. AIOStreams' Jellyfin server keeps their versions itself.

On a public instance there is nothing to set. If its owner has the cache on, lookups with a linked or pasted URL are exact. If not, BttrSubs asks again up to twice. It takes a stream with the played file's name, or another version of that release only when its size matches exactly.

## The password

BttrSubs uses your AIOStreams password for three things: to get an install URL of its own, to read the install URLs in your linked apps, and to sign in to AIOStreams' Jellyfin server. It changes nothing in AIOStreams.

The password is stored encrypted inside your BttrSubs install URL and is sent only to your AIOStreams. If AIOStreams refuses it, BttrSubs stops using it for an hour, because AIOStreams limits failed sign-ins.
