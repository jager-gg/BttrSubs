/**
 * Adds a configuration to its own AIOStreams account as a subtitle addon, so nobody has to paste
 * the install URL there.
 *
 * AIOStreams keeps an account's addons in its configuration and saves that configuration whole: it
 * is read with the account's ID and password, this addon's entry is added or put right, and it is
 * saved back. AIOStreams checks the whole configuration on every save and refuses one it doesn't
 * accept, so a refused save changes nothing there.
 *
 * An entry is this server's when its manifest URL is under the server's public address. The
 * account's one such entry is taken over (a configuration made again has a new URL); with several,
 * only the one with this URL is touched.
 */
import { randomBytes } from "node:crypto";
import { accountIn } from "./aiostreamsAccount.js";
import { config } from "./config.js";
import type { Settings } from "./profile.js";

/** How long AIOStreams gets to answer: a save checks every addon in the configuration. */
const TIMEOUT_MS = 30_000;
/**
 * What the entry's timeout is over the list's time: a list can take 1.5 s longer on a first play,
 * and AIOStreams drops an addon's whole answer past its timeout.
 */
const TIMEOUT_OVER_LIST_MS = 3000;
/** The timeout this addon's entry in AIOStreams needs for the list's time as it is set now, in ms. */
export const entryTimeoutMs = (): number => config.listBudgetMs + TIMEOUT_OVER_LIST_MS;
const ENTRY_NAME = "BttrSubs";

export type AddedToAiostreams = { state: "added" | "updated" | "present"; name: string } | { error: string };

interface Preset {
  type?: unknown;
  instanceId?: unknown;
  enabled?: unknown;
  options?: Record<string, unknown>;
}

function basic(uuid: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${uuid}:${password}`).toString("base64")}` };
}

/** A short id no other entry of the configuration has, as AIOStreams gives each addon. */
function freeInstanceId(presets: Preset[]): string {
  const taken = new Set(presets.map((preset) => String(preset.instanceId ?? "")));
  for (let tries = 0; tries < 100; tries++) {
    const id = randomBytes(2).toString("hex").slice(0, 3);
    if (!taken.has(id)) return id;
  }
  return randomBytes(4).toString("hex");
}

/** Why AIOStreams refused, in its own words when it gives any: one line, no markup. */
async function reasonOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown } | undefined;
  const said = typeof body?.error === "object" ? body.error?.message : (body?.error ?? body?.detail ?? body?.message);
  return typeof said === "string" && said.trim() ? said.replace(/\s+/g, " ").trim().slice(0, 200) : `HTTP ${response.status}`;
}

/** Puts an entry right for this manifest URL; false when it already was. */
function putRight(preset: Preset, manifestUrl: string, timeout: number): boolean {
  const options = (preset.options ??= {});
  const resources = Array.isArray(options.resources) ? (options.resources as unknown[]) : undefined;
  const right =
    options.manifestUrl === manifestUrl &&
    preset.enabled !== false &&
    typeof options.timeout === "number" &&
    options.timeout >= timeout &&
    // No resources named means every one the addon offers.
    (!resources || resources.length === 0 || resources.includes("subtitles"));
  if (right) return false;
  options.manifestUrl = manifestUrl;
  preset.enabled = true;
  if (typeof options.timeout !== "number" || options.timeout < timeout) options.timeout = timeout;
  if (resources && resources.length > 0 && !resources.includes("subtitles")) options.resources = [...resources, "subtitles"];
  return true;
}

/**
 * Adds the configuration's manifest URL to its AIOStreams account, or puts the entry it has there
 * right (its URL, switched on, subtitles among its resources, a timeout the list's time fits in).
 * Needs the account's password kept with the configuration.
 */
export async function addToAiostreams(settings: Settings | undefined, manifestUrl: string): Promise<AddedToAiostreams> {
  const account = settings?.aiostreams ? accountIn(settings.aiostreams) : undefined;
  const password = settings?.aiostreamsPassword;
  if (!account || !password) return { error: "This configuration has no AIOStreams password saved, so add the install URL in AIOStreams yourself" };
  if (!config.publicBaseUrl || !manifestUrl.startsWith(`${config.publicBaseUrl}/`)) return { error: "This server has no PUBLIC_BASE_URL set" };
  const base = account.origin === config.ownAiostreams ? config.aiostreamsBase : account.origin;
  const headers = basic(account.uuid, password);

  const read = await fetch(`${base}/api/v1/user?raw=true`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
  if (!read) return { error: "AIOStreams didn't answer. Try again, or add the install URL there yourself" };
  if (read.status === 400 || read.status === 401 || read.status === 403 || read.status === 404) return { error: "AIOStreams didn't accept the saved password. Save this configuration again with the current one" };
  if (!read.ok) return { error: `AIOStreams couldn't be read (${await reasonOf(read)}). Add the install URL there yourself` };
  const body = (await read.json().catch(() => undefined)) as { data?: { userData?: Record<string, unknown> } } | undefined;
  const userData = body?.data?.userData;
  if (!userData || typeof userData !== "object") return { error: "AIOStreams answered without the configuration. Add the install URL there yourself" };

  const presets = (Array.isArray(userData.presets) ? userData.presets : []) as Preset[];
  const timeout = entryTimeoutMs();
  const ours = presets.filter((preset) => typeof preset?.options?.manifestUrl === "string" && (preset.options.manifestUrl as string).startsWith(`${config.publicBaseUrl}/`));
  const entry = ours.find((preset) => preset.options?.manifestUrl === manifestUrl) ?? (ours.length === 1 ? ours[0] : undefined);
  let state: "added" | "updated" | "present";
  let name = ENTRY_NAME;
  if (entry) {
    name = typeof entry.options?.name === "string" && entry.options.name ? entry.options.name : ENTRY_NAME;
    if (!putRight(entry, manifestUrl, timeout)) return { state: "present", name };
    state = "updated";
  } else {
    presets.push({
      type: "custom",
      instanceId: freeInstanceId(presets),
      enabled: true,
      options: { name: ENTRY_NAME, manifestUrl, timeout, resources: ["subtitles"], mediaTypes: [], libraryAddon: false, resultPassthrough: false },
    });
    state = "added";
  }

  const saved = await fetch(`${base}/api/v1/user`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ config: { ...userData, presets } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
  if (!saved) return { error: "AIOStreams didn't answer the save. Check Addons there before trying again" };
  if (!saved.ok) return { error: `AIOStreams didn't save it (${await reasonOf(saved)}). Add the install URL there yourself` };
  return { state, name };
}
