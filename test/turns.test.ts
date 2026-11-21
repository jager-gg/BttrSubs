/**
 * Turns at hearing a file's audio (src/turns.ts): one file at a time per configuration, in the order
 * they came, and the file a download is waiting on at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hearingTurn, MAX_TURN_WAIT_MS, resetTurns, watching } from "../src/turns.js";

const CONFIG = "https://aio.example/stremio/a/b/manifest.json";
/** Lets every pending promise run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetTurns());
afterEach(() => vi.useRealTimers());

describe("turns at hearing a file's audio", () => {
  it("hears the next episode, listed ahead, after the one listed first", async () => {
    const order: string[] = [];
    const first = await hearingTurn(CONFIG, "Show.S01E14.mp4/451013473");
    order.push("E14 starts");
    const second = hearingTurn(CONFIG, "Show.S01E15.mp4/774926721").then((t) => (order.push("E15 starts"), t));
    await settle();
    expect(order).toEqual(["E14 starts"]);
    first.done();
    const t = await second;
    expect(order).toEqual(["E14 starts", "E15 starts"]);
    t.done();
  });

  it("starts a waiting file at once when a download asks for it, by name with or without its size", async () => {
    const asked = await hearingTurn(CONFIG, "Show.S01E15.mp4/774926721");
    let started = false;
    const watched = hearingTurn(CONFIG, "Show.S01E14.mp4/451013473").then((t) => ((started = true), t));
    await settle();
    expect(started).toBe(false);
    watching("Show.S01E14.mp4");
    const t = await watched;
    expect(started).toBe(true);
    t.done();
    asked.done();
  });

  it("lets a watched file in beside another, and holds the rest back until both are done", async () => {
    watching("Show.S01E14.mp4/451013473");
    const other = await hearingTurn(CONFIG, "Show.S01E13.mp4/1");
    const watched = await hearingTurn(CONFIG, "Show.S01E14.mp4/451013473");
    expect(watched.waitedMs).toBeLessThan(50);
    let third = false;
    const later = hearingTurn(CONFIG, "Show.S01E15.mp4/2").then((t) => ((third = true), t));
    other.done();
    await settle();
    expect(third).toBe(false);
    watched.done();
    (await later).done();
    expect(third).toBe(true);
  });

  it("keeps configurations apart", async () => {
    const a = await hearingTurn(CONFIG, "Show.S01E14.mp4/1");
    const b = await hearingTurn("https://aio.example/stremio/c/d/manifest.json", "Show.S01E15.mp4/2");
    expect(b.waitedMs).toBeLessThan(50);
    a.done();
    b.done();
  });

  it("never waits past the limit for a hearing that hangs", async () => {
    vi.useFakeTimers();
    await hearingTurn(CONFIG, "Show.S01E14.mp4/1");
    let started = false;
    const waiting = hearingTurn(CONFIG, "Show.S01E15.mp4/2").then((t) => ((started = true), t));
    await vi.advanceTimersByTimeAsync(MAX_TURN_WAIT_MS - 1);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(started).toBe(true);
  });

  it("lets one file in when a hearing ends, not every waiting one", async () => {
    const first = await hearingTurn(CONFIG, "Show.S01E01.mp4/1");
    const started: string[] = [];
    const rest = ["E02", "E03"].map((e) => hearingTurn(CONFIG, `Show.S01${e}.mp4/1`).then((t) => (started.push(e), t)));
    first.done();
    await settle();
    expect(started).toEqual(["E02"]);
    (await rest[0]).done();
    await settle();
    expect(started).toEqual(["E02", "E03"]);
    (await rest[1]).done();
  });
});
