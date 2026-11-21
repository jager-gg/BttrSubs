import { isIP } from "node:net";
import type { Request } from "express";

/**
 * The address each configuration's player asks from, sent to AIOStreams with a stream lookup as
 * X-AIOStreams-User-IP. AIOStreams builds a stream list for the viewer's address (it hands it to the
 * addons and debrid services it asks), and its pipeline cache (PIPELINE_CACHE_TTL) keeps a finished
 * list under the whole request: the install URL as it was written, and that address. A lookup sent
 * with the player's address and the player's install URL (a linked app's, or one pasted in) therefore
 * gets the very list the player chose from while that cache keeps it; with another copy of the URL, it
 * gets a list built for the same viewer. A lookup sent without the address gets a list of its own,
 * which can differ more: with dynamic fetching, AIOStreams answers once its condition is met and drops
 * slower addons' results.
 *
 * A subtitle list asked through AIOStreams carries the viewer's address in X-AIOStreams-User-IP (it
 * forwards the address it works out to every addon it asks, unless its proxy asks for them), so the
 * address noted is the one AIOStreams keyed the viewer's stream list by. Addresses are kept in memory
 * only, never written or logged.
 */

/** How long a configuration's last player address is used: about one evening of viewing. */
const KEPT_MS = 6 * 60 * 60 * 1000;
/** Configurations and episodes remembered at most; the oldest go first. */
const MAX_KEPT = 5000;

/**
 * Headers AIOStreams reads a viewer's address from, in its own order (its ip middleware): an address
 * worked out the same way from the same proxy's headers is the one AIOStreams keys the list by.
 */
const ADDRESS_HEADERS: Array<[string, boolean]> = [
  ["x-aiostreams-user-ip", false],
  ["x-client-ip", false],
  ["x-forwarded-for", true],
  ["x-real-ip", false],
  ["cf-connecting-ip", false],
  ["true-client-ip", false],
  ["x-forwarded", true],
  ["forwarded-for", true],
];

/** Addresses AIOStreams drops as private (its own test), so sending one changes nothing. */
const PRIVATE = /^(10\.|(::ffff:)?127\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|::1)/;

const publicAddress = (value: string | undefined): string | undefined => {
  const address = value?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  return address && isIP(address) !== 0 && !PRIVATE.test(address) ? address : undefined;
};

/**
 * The player's public address for a request, or undefined when it has none (a player on the same
 * private network). Proxy headers are read only from a proxy the app trusts (its "trust proxy"
 * setting: this machine or a private network), in AIOStreams' order, so a proxy that passes on a
 * CDN's client header gives the same address to both; a request from anywhere else is its own
 * connection's address.
 */
export function viewerAddress(req: Request): string | undefined {
  const peer = req.socket?.remoteAddress;
  const trusted = req.app?.get("trust proxy fn") as ((address: string, hop: number) => boolean) | undefined;
  if (peer && trusted?.(peer, 0)) {
    for (const [name, list] of ADDRESS_HEADERS) {
      const value = req.get(name);
      if (!value) continue;
      return publicAddress(list ? value.split(",")[0] : value);
    }
  }
  return publicAddress(peer);
}

interface Seen {
  address: string;
  at: number;
}
const byEpisode = new Map<string, Seen>();
const byConfig = new Map<string, Seen>();

const keep = (map: Map<string, Seen>, key: string, seen: Seen) => {
  map.delete(key);
  map.set(key, seen);
  while (map.size > MAX_KEPT) map.delete(map.keys().next().value!);
};

/** A player asked about this episode with this configuration from this address. */
export function noteViewer(aiostreamsUrl: string, videoId: string | undefined, address: string | undefined): void {
  if (!address) return;
  const seen = { address, at: Date.now() };
  if (videoId) keep(byEpisode, `${aiostreamsUrl}\n${videoId}`, seen);
  keep(byConfig, aiostreamsUrl, seen);
}

/**
 * The address to look this episode up for: the one its player asked from, else the configuration's
 * latest (an episode read ahead, before its player asks), while fresh.
 */
export function viewerOf(aiostreamsUrl: string, videoId: string): string | undefined {
  const fresh = (seen: Seen | undefined) => (seen && Date.now() - seen.at < KEPT_MS ? seen.address : undefined);
  return fresh(byEpisode.get(`${aiostreamsUrl}\n${videoId}`)) ?? fresh(byConfig.get(aiostreamsUrl));
}

/** Forgets every address (tests). */
export function resetViewers(): void {
  byEpisode.clear();
  byConfig.clear();
}
