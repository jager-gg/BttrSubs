import { describe, expect, it } from "vitest";
import { filterAndRankDubtitles } from "../src/matching.js";
import { qualityTier } from "../src/quality.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "../src/types.js";

function sub(partial: Partial<SubSourceSubtitle>): SubSourceSubtitle {
  return { subtitleId: 1, movieId: 1, language: "arabic", releaseInfo: [], commentary: null, files: 1, downloads: 0, rating: { good: 0, bad: 0, total: 0 }, ...partial };
}

describe("translation quality", () => {
  it("drops machine and AI translations", () => {
    expect(qualityTier(sub({ commentary: "ترجمة آلية" }))).toBe(-1);
    expect(qualityTier(sub({ commentary: "Translated with ChatGPT" }))).toBe(-1);
    expect(qualityTier(sub({ commentary: "AI translated from English" }))).toBe(-1);
    expect(qualityTier(sub({ commentary: "ترجمة جوجل" }))).toBe(-1);
    expect(qualityTier(sub({ productionType: "machine translated" }))).toBe(-1);
  });

  it("treats Crunchyroll, Netflix and retail as official", () => {
    expect(qualityTier(sub({ commentary: "ترجمة كرانشي رول" }))).toBe(3);
    expect(qualityTier(sub({ commentary: "ترجمة كرنشي رول https://animesubarb.blogspot.com/" }))).toBe(3);
    expect(qualityTier(sub({ releaseInfo: ["Show.S01E01.1080p.NF.WEB-DL"], commentary: "Netflix" }))).toBe(3);
    expect(qualityTier(sub({ productionType: "retail" }))).toBe(3);
  });

  it("treats credited teams and sites as human, and the rest as unknown", () => {
    expect(qualityTier(sub({ commentary: "https://example.com/ horriblesubs متوافق" }))).toBe(2);
    expect(qualityTier(sub({ productionType: "improved" }))).toBe(2);
    expect(qualityTier(sub({ releaseInfo: ["Show 2017 - Ep001 To Ep170"] }))).toBe(1);
  });

  it("ranks an episode's Arabic: official, then human, then unknown", () => {
    const request: StremioSubtitleRequest = { type: "series", id: "tt0000004:1:13", imdbId: "tt0000004", season: 1, episode: 13, absoluteEpisode: 13 };
    const ranked = filterAndRankDubtitles(
      [
        sub({ subtitleId: 101, files: 170, downloads: 17, releaseInfo: ["Show 2017 - Ep001 To Ep170"] }),
        sub({ subtitleId: 102, downloads: 3, releaseInfo: ["[Group] Show - 13"], commentary: "https://example.com/ horriblesubs متوافق" }),
        sub({ subtitleId: 103, downloads: 2, releaseInfo: ["[HorribleSubs] Show - 13 [1080p]"], commentary: "ترجمة كرانشي رول" }),
        sub({ subtitleId: 9, downloads: 50, releaseInfo: ["Show - 13"], commentary: "ترجمة آلية" })
      ],
      request,
      { requireDub: false }
    );
    expect(ranked.map((s) => s.subtitleId)).toEqual([103, 102, 101]);
  });
});

describe("English CC fallback inputs (Netflix packs)", () => {
  it("places an episode in a pack that only says how many episodes it has, and keeps official HI tracks", () => {
    const request: StremioSubtitleRequest = { type: "series", id: "kitsu:1001:7", imdbId: "tt0000007", season: 1, episode: 7, absoluteEpisode: 7 };
    const ranked = filterAndRankDubtitles(
      [
        sub({ subtitleId: 201, language: "english", files: null, releaseInfo: ["Show"], commentary: "Rip from NETFLIX. (26 episodes - First Arc", hearingImpaired: false }),
        sub({ subtitleId: 202, language: "english", files: null, releaseInfo: ["Show"], commentary: "Rip from NETFLIX. (26 episodes - First Arc", hearingImpaired: true }),
        sub({ subtitleId: 203, language: "english", files: null, releaseInfo: ["TEAM Show 1-26 complete"], commentary: "https://example.com/", hearingImpaired: true })
      ],
      request,
      { requireDub: false, hearingImpaired: "only" }
    );
    expect(ranked.filter((s) => s.quality === 3).map((s) => s.subtitleId)).toEqual([202]);
    expect(filterAndRankDubtitles(ranked, { ...request, episode: 27, absoluteEpisode: 27 }, { requireDub: false })).toHaveLength(0);
  });
});
