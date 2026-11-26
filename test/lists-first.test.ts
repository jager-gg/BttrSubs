/**
 * A list in its last stretch has the thread to itself (sync.ts, listFinishing): a read of the audio
 * under way waits for listsFirst before each piece it feeds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listFinishing, listsFirst } from "../src/sync.js";

afterEach(() => vi.useRealTimers());

describe("reads of the audio stand aside for a list that is finishing", () => {
  it("goes straight on when no list is finishing", async () => {
    let on = false;
    await listsFirst().then(() => (on = true));
    expect(on).toBe(true);
  });

  it("waits until the list's answer is sent, and for every list finishing", async () => {
    let sendFirst!: () => void;
    let sendSecond!: () => void;
    listFinishing(new Promise<void>((resolve) => (sendFirst = resolve)));
    let on = false;
    const waiting = listsFirst().then(() => (on = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(on).toBe(false);
    // A second list reaches its last stretch while the first is still at it.
    listFinishing(new Promise<void>((resolve) => (sendSecond = resolve)));
    sendFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(on).toBe(false);
    sendSecond();
    await waiting;
    expect(on).toBe(true);
  });

  it("goes on after 4 s whatever becomes of the list, and when its answer fails", async () => {
    vi.useFakeTimers();
    listFinishing(new Promise<void>(() => {}));
    let on = false;
    const waiting = listsFirst().then(() => (on = true));
    await vi.advanceTimersByTimeAsync(3900);
    expect(on).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await waiting;
    expect(on).toBe(true);
    vi.useRealTimers();
    listFinishing(Promise.reject(new Error("the connection closed")));
    await listsFirst();
  });
});
