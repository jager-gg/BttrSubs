/**
 * The other ways into a configuration's AIOStreams account, by its first install URL.
 *
 * Other install URLs: each player keeps its own copy of the install URL (the one installed in a
 * Stremio app, the one saved in a metadata server), and AIOStreams writes the password differently
 * into every copy and keeps a finished stream list under the copy it was asked with. A lookup asked
 * with one copy therefore gets a list built for it, which can lack the file a player on another copy
 * is playing; asked with that player's copy, it gets the list the player chose from.
 *
 * The account's password: it reads the copies AIOStreams itself put into linked apps, and signs in to
 * AIOStreams' own Jellyfin server, whose players have no install URL (aiostreamsAccount.ts).
 *
 * Both carry the account's credentials, so they are kept in memory only, never written or logged.
 */
interface Ways {
  also: string[];
  password?: string;
}
const ways = new Map<string, Ways>();
/** Configurations remembered at most; the one noted longest ago goes first. */
const MAX_KEPT = 5000;

/** A configuration's first install URL with its other copies and its account password, as its settings hold them now. */
export function noteInstallUrls(first: string | undefined, also: string[], password?: string): void {
  if (!first) return;
  ways.delete(first);
  if (also.length === 0 && !password) return;
  ways.set(first, { also, password });
  while (ways.size > MAX_KEPT) ways.delete(ways.keys().next().value!);
}

/** The other copies of this install URL's configuration, in the order they were added. */
export function otherInstallUrls(first: string): string[] {
  return ways.get(first)?.also ?? [];
}

/** The password of the configuration's AIOStreams account, when its settings hold it. */
export function passwordOf(first: string): string | undefined {
  return ways.get(first)?.password;
}

export function forgetInstallUrls(): void {
  ways.clear();
}
