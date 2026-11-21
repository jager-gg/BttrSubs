import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const saved = process.env.CACHE_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CACHE_DIR;
  else process.env.CACHE_DIR = saved;
  vi.resetModules();
});

describe("the cache folder", () => {
  it("is CACHE_DIR as given when that is an absolute path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bttr-cache-"));
    try {
      process.env.CACHE_DIR = dir;
      vi.resetModules();
      const { cachePath } = await import("../src/cache.js");
      expect(cachePath("synced", "a.srt")).toBe(path.join(dir, "synced", "a.srt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is inside the working folder when CACHE_DIR is relative", async () => {
    process.env.CACHE_DIR = "some-cache";
    vi.resetModules();
    const { cachePath } = await import("../src/cache.js");
    expect(cachePath("anchors")).toBe(path.join(process.cwd(), "some-cache", "anchors"));
  });
});
