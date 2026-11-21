/**
 * What a configuration's AIOStreams ID and password reach that an install URL doesn't.
 *
 * An install URL of its own: AIOStreams writes one for whoever signs in, so a configuration is set
 * up from the instance's address, the ID and the password, with no URL to copy.
 *
 * The install URLs in linked apps: AIOStreams keeps the URL it put into each linked account and
 * pushes that same one again, so asked with it a lookup gets the list that app chose from.
 *
 * Its own Jellyfin server: a player signed in there has no install URL. The server keeps a title's
 * versions under the account, whichever device asks, so a sign-in of this addon's own is answered
 * the versions the player was shown (aiostreamsJellyfin.ts).
 *
 * A refused password is left alone for a while: AIOStreams limits failed sign-ins, and asking again
 * with the same password can only fail again.
 */
import { passwordOf } from "./installUrls.js";

/** How long a refused password is left alone. */
const REFUSED_WAIT_MS = 60 * 60_000;
/** How long the linked apps' URLs are reused: lookups for one play come within seconds of each other. */
const LINKED_KEPT_MS = 60_000;
/** Configurations with a sign-in remembered at most. */
const MAX_KEPT = 5000;

interface Session {
  password: string;
  token?: string;
  refusedAt?: number;
  linked?: { urls: string[]; at: number };
}
const sessions = new Map<string, Session>();

export type SignIn = { encryptedPassword: string } | "refused" | undefined;

function basic(uuid: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${uuid}:${password}`).toString("base64")}` };
}

/** The instance and account an install URL names. */
export function accountIn(installUrl: string): { origin: string; uuid: string } | undefined {
  const match = /^(https?:\/\/[^/]+)\/stremio\/([^/\s]+)\/[^/\s]+\/manifest\.json$/.exec(installUrl);
  return match ? { origin: match[1], uuid: match[2] } : undefined;
}

/**
 * Signs in with the ID and password: the password as AIOStreams writes it into an install URL, new
 * at every sign-in. "refused" when AIOStreams turns the pair away; undefined when it doesn't answer.
 */
export async function signIn(origin: string, uuid: string, password: string, timeoutMs: number): Promise<SignIn> {
  const response = await fetch(`${origin}/api/v1/user`, { headers: basic(uuid, password), signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
  if (!response) return undefined;
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) return "refused";
  if (!response.ok) return undefined;
  const body = (await response.json().catch(() => undefined)) as { data?: { encryptedPassword?: unknown } } | undefined;
  const encryptedPassword = body?.data?.encryptedPassword;
  return typeof encryptedPassword === "string" && /^[^/\s]+$/.test(encryptedPassword) ? { encryptedPassword } : undefined;
}

/** The configuration's sign-in as it stands, or undefined when it has no password or its password was refused lately. */
function sessionOf(first: string): { origin: string; uuid: string; session: Session } | undefined {
  const password = passwordOf(first);
  const account = accountIn(first);
  if (!password || !account) return undefined;
  let session = sessions.get(first);
  if (!session || session.password !== password) {
    session = { password };
    sessions.delete(first);
    sessions.set(first, session);
    while (sessions.size > MAX_KEPT) sessions.delete(sessions.keys().next().value!);
  }
  if (session.refusedAt !== undefined && Date.now() - session.refusedAt < REFUSED_WAIT_MS) return undefined;
  return { ...account, session };
}

function refused(first: string, session: Session, where: string): void {
  session.refusedAt = Date.now();
  session.token = undefined;
  console.log(`sync: AIOStreams refused the saved password (${where}) for the account ${accountIn(first)?.uuid.slice(0, 8)}: it is left alone for an hour. Save the configuration again with the current password`);
}

/** A linked app as AIOStreams lists it: its platform, how its last push went, and the install URLs it put there. */
export interface LinkedApp {
  platform: string;
  /** "ok", "error" or "expired" once pushed; none before the first push. */
  lastStatus?: string;
  urls: string[];
}

/**
 * The account's linked apps. "refused" when AIOStreams turns the pair away; "unavailable" when it
 * answers without them (an AIOStreams without linked accounts); undefined when it doesn't answer.
 */
export async function linkedAppsOf(origin: string, uuid: string, password: string, timeoutMs: number): Promise<LinkedApp[] | "refused" | "unavailable" | undefined> {
  const response = await fetch(`${origin}/api/v1/linked-accounts`, { headers: basic(uuid, password), signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
  if (!response) return undefined;
  if (response.status === 401) return "refused";
  if (!response.ok) return "unavailable";
  const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
  if (!Array.isArray(body?.data)) return "unavailable";
  return (body.data as Array<{ platform?: unknown; lastStatus?: unknown; config?: { manifestUrls?: unknown } }>).map((app) => ({
    platform: typeof app?.platform === "string" ? app.platform : "",
    ...(typeof app?.lastStatus === "string" ? { lastStatus: app.lastStatus } : {}),
    urls: (Array.isArray(app?.config?.manifestUrls) ? app.config.manifestUrls : []).filter((url): url is string => typeof url === "string"),
  }));
}

/**
 * The install URLs AIOStreams put into the account's linked apps, as reached from here: each is this
 * account's, and is asked at the address the first one is. None without a password, or when
 * AIOStreams doesn't answer.
 */
export async function linkedInstallUrls(first: string, timeoutMs: number): Promise<string[]> {
  const found = sessionOf(first);
  if (!found) return [];
  const { origin, uuid, session } = found;
  if (session.linked && Date.now() - session.linked.at < LINKED_KEPT_MS) return session.linked.urls;
  const apps = await linkedAppsOf(origin, uuid, session.password, timeoutMs);
  if (apps === "refused") {
    refused(first, session, "linked accounts");
    return [];
  }
  if (!Array.isArray(apps)) return [];
  const urls: string[] = [];
  for (const url of apps.flatMap((app) => app.urls)) {
    const match = /^https?:\/\/[^/]+(\/stremio\/([^/\s]+)\/[^/\s]+\/manifest\.json)$/.exec(url);
    if (!match || match[2].toLowerCase() !== uuid.toLowerCase()) continue;
    const reached = `${origin}${match[1]}`;
    if (reached !== first && !urls.includes(reached)) urls.push(reached);
  }
  session.linked = { urls, at: Date.now() };
  return urls;
}

/**
 * A sign-in to the account's Jellyfin server: its token. "refused" when the server turns the pair
 * away; "unavailable" when it answers without a sign-in (the server is off); undefined when it
 * doesn't answer.
 */
export async function jellyfinSignIn(origin: string, uuid: string, password: string, timeoutMs: number): Promise<{ token: string } | "refused" | "unavailable" | undefined> {
  const response = await fetch(`${origin}/jellyfin/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: 'MediaBrowser Client="BttrSubs", Device="BttrSubs", DeviceId="bttrsubs", Version="1"' },
    body: JSON.stringify({ Username: uuid, Pw: password }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);
  if (!response) return undefined;
  if (response.status === 401) return "refused";
  if (!response.ok) return "unavailable";
  const body = (await response.json().catch(() => undefined)) as { AccessToken?: unknown } | undefined;
  return typeof body?.AccessToken === "string" && body.AccessToken ? { token: body.AccessToken } : "unavailable";
}

/**
 * A sign-in to the account's Jellyfin server, kept for as long as this process runs: the token names
 * the account and holds no expiry. None without a password, or when the server is off or refuses.
 */
export async function jellyfinToken(first: string, timeoutMs: number): Promise<string | undefined> {
  const found = sessionOf(first);
  if (!found) return undefined;
  const { origin, uuid, session } = found;
  if (session.token) return session.token;
  const signed = await jellyfinSignIn(origin, uuid, session.password, timeoutMs);
  if (signed === "refused") {
    refused(first, session, "its Jellyfin server");
    return undefined;
  }
  if (typeof signed !== "object") return undefined;
  session.token = signed.token;
  return session.token;
}

/** For tests: forget every sign-in. */
export function forgetAccounts(): void {
  sessions.clear();
}
