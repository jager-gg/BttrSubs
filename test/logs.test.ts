import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { logFiles, logFilesWritten, scrubLine, sendLogs, startLogFiles, stopLogFiles } from "../src/logs.js";

const DAY = 86_400_000;
const START = Date.parse("2026-01-10T08:00:00Z");
let dir = "";
let clock = START;

function start(days: number, maxBytes = 1e6): void {
  dir = mkdtempSync(path.join(tmpdir(), "bttr-logs-"));
  clock = START;
  startLogFiles({ dir, days, maxBytes, now: () => clock });
}

afterEach(async () => {
  await stopLogFiles();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("a log line as a file keeps it", () => {
  it("cuts each address to its host and long tokens out, and leaves the rest as it is", () => {
    expect(scrubLine("lookup https://aio.example.com/stremio/0000-uuid/Zm9vYmFy/manifest.json failed")).toBe("lookup https://aio.example.com/… failed");
    expect(scrubLine("accepted from: https://a.example.org, https://b.example.net (reached at http://aiostreams:3000)")).toBe("accepted from: https://a.example.org, https://b.example.net (reached at http://aiostreams:3000)");
    expect(scrubLine("download https://dl.example.com/file.mkv?token=abc: 403")).toBe("download https://dl.example.com/…: 403");
    expect(scrubLine(`link ${"A1b2".repeat(10)} saved`)).toBe("link <token> saved");
    expect(scrubLine("Show.S01E02.1080p.WEB-DL [Group]: synced +40 ms")).toBe("Show.S01E02.1080p.WEB-DL [Group]: synced +40 ms");
  });
});

describe("log files", () => {
  it("write every console line to one file per UTC day, with its time and level, scrubbed", async () => {
    start(7);
    console.log("listening on :%d", 7000);
    console.warn("lookup https://aio.example.com/stremio/secret/manifest.json slow");
    clock += DAY;
    console.error("next day");
    await stopLogFiles();
    expect(readdirSync(dir).sort()).toEqual(["bttrsubs-2026-01-10.log", "bttrsubs-2026-01-11.log"]);
    expect(readFileSync(path.join(dir, "bttrsubs-2026-01-10.log"), "utf8")).toBe(
      "2026-01-10T08:00:00.000Z info listening on :7000\n2026-01-10T08:00:00.000Z warn lookup https://aio.example.com/… slow\n"
    );
    expect(readFileSync(path.join(dir, "bttrsubs-2026-01-11.log"), "utf8")).toBe("2026-01-11T08:00:00.000Z error next day\n");
  });

  it("give a line written during a request, or work it started, the request's id", async () => {
    const { requestContext } = await import("../src/stats.js");
    start(7);
    await requestContext.run({ link: "logs0001/aa", req: "Req0001x" }, async () => {
      console.log("asked");
      await new Promise((resolve) => setTimeout(resolve, 5));
      console.log("after a wait");
    });
    console.log("outside");
    await stopLogFiles();
    expect(readFileSync(path.join(dir, "bttrsubs-2026-01-10.log"), "utf8")).toBe(
      "2026-01-10T08:00:00.000Z info req=Req0001x asked\n2026-01-10T08:00:00.000Z info req=Req0001x after a wait\n2026-01-10T08:00:00.000Z info outside\n"
    );
  });

  it("keep the last LOG_DAYS days, today included", async () => {
    start(3);
    for (let i = 0; i < 5; i++) {
      console.log(`day ${i}`);
      clock += DAY;
      await logFilesWritten();
    }
    console.log("day 5");
    await stopLogFiles();
    expect(logFiles(dir).map((f) => f.day)).toEqual(["2026-01-13", "2026-01-14", "2026-01-15"]);
  });

  it("stay under LOG_MAX_MB: the oldest day goes first, and a day that fills the cap alone stops with a note", async () => {
    // Words, not one long run (a run of 32+ letters is cut as a token): each line is 131 bytes.
    const text = (c: string) => `${c} `.repeat(50);
    start(7, 300);
    console.log(text("x"));
    clock += DAY;
    await logFilesWritten();
    console.log(text("y"));
    clock += DAY;
    await logFilesWritten();
    // Today's first line doesn't fit beside both earlier days: the oldest goes.
    console.log(text("z"));
    await logFilesWritten();
    expect(logFiles(dir).map((f) => f.day)).toEqual(["2026-01-11", "2026-01-12"]);
    // Today alone fills the cap: yesterday goes, then a note, then nothing more today.
    for (let i = 0; i < 4; i++) console.log(text("w"));
    await stopLogFiles();
    const today = readFileSync(path.join(dir, "bttrsubs-2026-01-12.log"), "utf8");
    expect(logFiles(dir).map((f) => f.day)).toEqual(["2026-01-12"]);
    expect(today).toContain("reached the LOG_MAX_MB cap");
    expect(today.split("\n").filter((l) => l.includes(text("w").trim())).length).toBe(1);
  });

  it("are off with LOG_DAYS=0", () => {
    dir = path.join(tmpdir(), `bttr-logs-off-${process.pid}`);
    startLogFiles({ dir, days: 0, maxBytes: 1e6 });
    console.log("not kept");
    expect(existsSync(dir)).toBe(false);
  });

  it("go out as one text, oldest day first, the line just written included", async () => {
    start(7);
    console.log("first");
    clock += DAY;
    await logFilesWritten();
    console.log("second");
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    await sendLogs(out);
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text.indexOf("info first")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("info second")).toBeGreaterThan(text.indexOf("info first"));
  });
});
