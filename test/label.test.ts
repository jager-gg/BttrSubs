import { describe, expect, it } from "vitest";
import { describe as describeRequest } from "../src/app.js";

describe("track descriptions (AIOStreams' label)", async () => {
  const { trackLabel } = await import("../src/app.js");
  it("names the addon on every track", () => {
    expect(trackLabel(undefined, true)).toBe("Dub · Synced · BttrSubs");
    // A sync not known yet claims nothing: "Auto sync", until a list knows it is timed.
    expect(trackLabel(undefined, "pending")).toBe("Dub · Auto sync · BttrSubs");
    expect(trackLabel("Arabic", "pending")).toBe("Auto sync · BttrSubs");
    expect(trackLabel(undefined, "pending", undefined, false, true)).toBe("Dub · Auto sync · Signs · BttrSubs");
    expect(trackLabel(undefined, false)).toBe("Dub · BttrSubs");
    expect(trackLabel("Arabic", true)).toBe("Synced · BttrSubs");
    expect(trackLabel("Arabic", false)).toBe("BttrSubs");
    expect(trackLabel(undefined, true, undefined, true)).toBe("CC · Synced · BttrSubs");
    expect(trackLabel(undefined, false, undefined, true)).toBe("CC · BttrSubs");
  });

  it("marks timing by speech in the audio apart", () => {
    expect(trackLabel("Arabic", true, "synced")).toBe("Synced by audio · BttrSubs");
    expect(trackLabel(undefined, true, "synced")).toBe("Dub · Synced by audio · BttrSubs");
    expect(trackLabel("Arabic", false, "synced")).toBe("BttrSubs");
  });

  it("doesn't claim an audio sync that hasn't finished", () => {
    expect(trackLabel("Arabic", true, "trying")).toBe("Audio sync · BttrSubs");
    expect(trackLabel(undefined, true, "trying")).toBe("Dub · Audio sync · BttrSubs");
    // Signs found for the playing file go with the dub, and the label says so.
    expect(trackLabel(undefined, true, undefined, false, true)).toBe("Dub · Synced · Signs · BttrSubs");
    expect(trackLabel(undefined, true, "synced", false, true)).toBe("Dub · Synced by audio · Signs · BttrSubs");
  });

  it("puts the episode in front of a file named by a random id, in the activity list", () => {
    expect(describeRequest("po0xCP6G.mkv", "tt0000006:3:8", 3, 8)).toBe("S03E08 · po0xCP6G");
    expect(describeRequest("Show.S03E09.1080p.mkv", "tt0000006:3:9", 3, 9)).toBe("Show.S03E09.1080p");
    expect(describeRequest("[Group] Show 013 (BD 1080p).mkv", "kitsu:1", 1, 13)).toBe("[Group] Show 013 (BD 1080p)");
    expect(describeRequest(undefined, "tt0000006:3:8", 3, 8)).toBe("tt0000006:3:8");
  });
});

describe("track names a player's preferred language picks", async () => {
  const { sentLanguage } = await import("../src/app.js");
  it("sends the language alone, the dub captions and English CC as English", () => {
    expect(sentLanguage({ code: "Arabic" })).toBe("Arabic");
    expect(sentLanguage({ code: "ara" })).toBe("Arabic");
    expect(sentLanguage({})).toBe("English");
  });
});

describe("listing synced subtitles only", async () => {
  const { profileFromSettings } = await import("../src/profile.js");
  const { setupState } = await import("../src/page.js");
  const base = { subsource: "sk_friends_own_key_1234", languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" as const };
  it("is off for links made before the switch, on when the link asks", () => {
    expect(profileFromSettings(base, "t").hideUnsynced).toBe(false);
    expect(profileFromSettings({ ...base, hideUnsynced: true }, "t").hideUnsynced).toBe(true);
  });
  it("starts its switch on the configure page from the link", () => {
    expect(setupState(undefined).current).toBeNull();
    expect(setupState(base).current?.hideUnsynced).toBe(false);
    expect(setupState({ ...base, hideUnsynced: true }).current?.hideUnsynced).toBe(true);
  });
});

describe("English Dub and regular English", async () => {
  const { profileFromSettings, REGULAR_ENGLISH, linkSummary, sealSettings } = await import("../src/profile.js");
  const { setupState } = await import("../src/page.js");
  const base = { subsource: "sk_friends_own_key_1234", allowMachine: false, hearingImpaired: "include" as const };
  it("keeps English meaning the dub captions, as links always have", () => {
    const profile = profileFromSettings({ ...base, languages: ["English", "Arabic"] }, "t");
    expect(profile.dub).toBe(true);
    expect(profile.extraLanguages).toEqual([{ name: "arabic", code: "Arabic" }]);
  });
  it("adds regular English as a language of its own, beside the dub or without it", () => {
    const both = profileFromSettings({ ...base, languages: ["English", REGULAR_ENGLISH] }, "t");
    expect(both.dub).toBe(true);
    expect(both.extraLanguages).toEqual([{ name: "english", code: "English" }]);
    const regularOnly = profileFromSettings({ ...base, languages: [REGULAR_ENGLISH, "Arabic"] }, "t");
    expect(regularOnly.dub).toBe(false);
    expect(regularOnly.extraLanguages.map((l) => l.code)).toEqual(["English", "Arabic"]);
  });
  it("shows both chips with what each is for, and names them apart on the dashboard", async () => {
    const state = setupState({ ...base, languages: [REGULAR_ENGLISH] });
    expect(state.regularEnglish).toBe("English Subtitles");
    expect(state.current?.languages).toEqual([REGULAR_ENGLISH]);
    // The page's chips: "English" (the dub) shown as English Dub, the regular subtitles as English.
    const { readFileSync } = await import("node:fs");
    const setup = readFileSync(new URL("../assets/ui/setup.js", import.meta.url), "utf8");
    expect(setup).toContain('const LANGS = [["English", "English Dub"], [S.regularEnglish, "English"]');
    expect(setup).toContain("<b>English Dub</b> is for watching the English dub");
    const { config } = await import("../src/config.js");
    config.configSecret ??= "label-test-secret-label-test-secret-1";
    expect(linkSummary(sealSettings({ ...base, languages: ["English", REGULAR_ENGLISH] }))?.languages).toEqual(["English Dub", "English"]);
  });
});

describe("whether a sync is good enough to serve", () => {
  it("is one rule everywhere: anchors, and speech only on a file with no subtitle track or one whose track is off the voices", async () => {
    const { syncedWell } = await import("../src/app.js");
    const anchors = [{ from: 0, to: 60000, offset: 500, score: 0.9 }];
    expect(syncedWell({ file: "x.srt", anchors })).toBe(true);
    expect(syncedWell({ file: "x.srt", anchors: [] })).toBe(false);
    expect(syncedWell({ file: "x.srt", anchors, bySpeech: true })).toBe(false);
    expect(syncedWell({ file: "x.srt", anchors, bySpeech: true, speechOnly: true })).toBe(true);
    expect(syncedWell({ file: "x.srt", anchors, bySpeech: true, overTrack: true })).toBe(true);
    expect(syncedWell({ file: "x.srt", anchors, byLines: true })).toBe(true);
    expect(syncedWell(undefined)).toBe(false);
    expect(syncedWell("late")).toBe(false);
    expect(syncedWell("wait")).toBe(false);
  });
});
