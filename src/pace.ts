/**
 * A gate for requests to a service that limits how fast one address may ask it.
 *
 * Every request to such a service goes through `paced`, under the service's name. It goes out only
 * when the service's pace has room: fewer than `perMinute` sent in the last minute, fewer than
 * `inFlight` unanswered, and no pause in force. A service that answers 429 has said the address went
 * too far: nothing more is sent to it until the time its Retry-After names, or `pausedMs` when it
 * names none. So the pace is kept here, before a request is made, and a refusal is never answered by
 * asking again.
 *
 * A request that would wait longer than `maxWaitMs` isn't made at all: what asked for it gets
 * nothing from that service this time, which costs a list one source and never its time.
 */
import { count } from "./stats.js";

export interface Pace {
  /** Requests in any one minute, at most. Set well under what the service allows: other things on the same address may ask it too. */
  perMinute: number;
  /** Requests unanswered at once, at most. */
  inFlight: number;
  /** How long nothing is sent after a 429 that names no time. */
  pausedMs: number;
  /** The longest a request waits for its turn before it is given up. */
  maxWaitMs: number;
}

interface Gate {
  /** When each request of the last minute went out. */
  sent: number[];
  running: number;
  pausedUntil: number;
}

const MINUTE_MS = 60_000;
const gates = new Map<string, Gate>();

function gateOf(service: string): Gate {
  let gate = gates.get(service);
  if (!gate) {
    gate = { sent: [], running: 0, pausedUntil: 0 };
    gates.set(service, gate);
  }
  return gate;
}

/** How long until this service's pace has room for one more request (0: now). */
function waitFor(gate: Gate, pace: Pace, now: number): number {
  gate.sent = gate.sent.filter((at) => now - at < MINUTE_MS);
  if (now < gate.pausedUntil) return gate.pausedUntil - now;
  if (gate.running >= pace.inFlight) return 50;
  if (gate.sent.length >= pace.perMinute) return gate.sent[0] + MINUTE_MS - now;
  return 0;
}

/** The pause a 429 asks for: its Retry-After in seconds or as a date, when it gives one that makes sense. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60 * MINUTE_MS);
  const at = Date.parse(header);
  return Number.isFinite(at) && at > now ? Math.min(at - now, 60 * MINUTE_MS) : undefined;
}

/** Thrown for a request that was never sent: its service is paused, or its turn was too far off. */
export class HeldBack extends Error {
  constructor(service: string, waitMs: number) {
    super(`${service}: not asked, its pace has no room for ${Math.round(waitMs / 1000)} s`);
    this.name = "HeldBack";
  }
}

/** One request to `service`, sent when its pace has room; a 429 pauses the service (see the top). */
export async function paced(service: string, pace: Pace, send: () => Promise<Response>): Promise<Response> {
  const gate = gateOf(service);
  const asked = Date.now();
  for (;;) {
    const now = Date.now();
    const wait = waitFor(gate, pace, now);
    if (wait === 0) break;
    if (now - asked + wait > pace.maxWaitMs) {
      count(`pace.${service}.heldBack`);
      throw new HeldBack(service, wait);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 250)).unref());
  }
  gate.sent.push(Date.now());
  gate.running++;
  try {
    const response = await send();
    if (response.status === 429) {
      const pause = retryAfterMs(response.headers.get("retry-after")) ?? pace.pausedMs;
      gate.pausedUntil = Math.max(gate.pausedUntil, Date.now() + pause);
      count(`pace.${service}.refused`);
      console.log(`${service}: answered 429, nothing more is asked of it for ${Math.round(pause / 1000)} s`);
    }
    return response;
  } finally {
    gate.running--;
  }
}

/** For the dashboard and tests: how many requests a service was sent in the last minute, and how long it is paused for. */
export function paceNow(service: string, now = Date.now()): { lastMinute: number; pausedMs: number } {
  const gate = gates.get(service);
  return { lastMinute: gate ? gate.sent.filter((at) => now - at < MINUTE_MS).length : 0, pausedMs: gate ? Math.max(0, gate.pausedUntil - now) : 0 };
}

/** For tests: forget every service's pace. */
export function forgetPaces(): void {
  gates.clear();
}
