/**
 * Feeding a process's standard input (src/sync.ts feed): a long feed into a slow reader waits many
 * times, and leaves no listener behind on the process or its input.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { feed } from "../src/sync.js";

describe("feeding a process", () => {
  it("waits while its input is full, and leaves no listener behind each time", async () => {
    // A reader that takes its input slowly, so the feed fills it again and again.
    const proc = spawn(process.execPath, ["-e", "process.stdin.on('data', () => { process.stdin.pause(); setTimeout(() => process.stdin.resume(), 2); })"], { stdio: ["pipe", "ignore", "ignore"] });
    const baseClose = proc.listenerCount("close");
    const baseDrain = proc.stdin.listenerCount("drain");
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarning);
    // Each write the input refuses for now is a wait.
    let waited = 0;
    const write = proc.stdin.write.bind(proc.stdin) as (chunk: Uint8Array) => boolean;
    (proc.stdin as unknown as { write: (chunk: Uint8Array) => boolean }).write = (c) => {
      const taken = write(c);
      if (!taken) waited++;
      return taken;
    };
    const chunk = new Uint8Array(256 * 1024);
    for (let i = 0; i < 60; i++) await feed(proc, chunk);
    process.off("warning", onWarning);
    expect(waited).toBeGreaterThan(10);
    expect(proc.listenerCount("close")).toBe(baseClose);
    expect(proc.stdin.listenerCount("drain")).toBe(baseDrain);
    expect(warnings).not.toContain("MaxListenersExceededWarning");
    proc.kill();
  }, 20000);
});
