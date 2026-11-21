import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { fileName, fileRef, scopedRef, syncKey } from "../src/sync.js";

const OWN = "http://aiostreams:3000/stremio/uuid-own/pass/manifest.json";
const OWN_PUBLIC = "https://aiostreams.example.com/stremio/uuid-own/pass/manifest.json";
const ELSEWHERE = "https://aio.public.example/stremio/uuid-a/pass/manifest.json";
const ELSEWHERE_OTHER = "https://aio.public.example/stremio/uuid-b/pass/manifest.json";

describe("whose readings a playing file's are", () => {
  const kept = { own: config.ownAiostreams, base: config.aiostreamsBase };
  afterEach(() => {
    config.ownAiostreams = kept.own;
    config.aiostreamsBase = kept.base;
  });
  const withOwn = () => {
    config.ownAiostreams = "https://aiostreams.example.com";
    config.aiostreamsBase = "http://aiostreams:3000";
  };

  it("shares a file's readings among accounts on this server's own AIOStreams, under the ref as it always was", () => {
    withOwn();
    const ref = fileRef("Show.S01E01.mkv", "123456");
    expect(scopedRef(OWN, ref)).toBe(ref);
    expect(scopedRef(OWN_PUBLIC, ref)).toBe(ref);
    expect(scopedRef(undefined, ref)).toBe(ref);
  });

  it("keeps an account on another instance apart, from the own instance and from every other account", () => {
    withOwn();
    const ref = fileRef("Show.S01E01.mkv", "123456");
    const a = scopedRef(ELSEWHERE, ref);
    const b = scopedRef(ELSEWHERE_OTHER, ref);
    expect(a).toMatch(/^@[0-9a-f]{10}\|Show\.S01E01\.mkv\/123456$/);
    expect(a).not.toBe(b);
    expect(syncKey("ss1", 1, 1, a)).not.toBe(syncKey("ss1", 1, 1, ref));
    // The name and the size read out of it as before.
    expect(fileName(a)).toBe("Show.S01E01.mkv");
    expect(scopedRef(ELSEWHERE, a)).toBe(a);
  });

  it("drops a scope a request sent in the name itself, so no account can name another's readings", () => {
    withOwn();
    const theirs = scopedRef(ELSEWHERE, "Show.S01E01.mkv");
    expect(scopedRef(ELSEWHERE_OTHER, theirs)).toBe(scopedRef(ELSEWHERE_OTHER, "Show.S01E01.mkv"));
    expect(scopedRef(OWN, theirs)).toBe("Show.S01E01.mkv");
  });

  it("with no own AIOStreams set, every account keeps its own", () => {
    config.ownAiostreams = undefined;
    config.aiostreamsBase = "http://aiostreams:3000";
    expect(scopedRef(OWN, "Show.S01E01.mkv")).toMatch(/^@[0-9a-f]{10}\|/);
  });
});
