import { describe, expect, it } from "vitest";
import {
  matchSearchToken,
  normalizeSearchText,
  prepareSearchText,
  scoreSearchFields,
  tokenizeSearchQuery,
} from "./app-sidebar-session-search-match.ts";

const score = (query: string, haystack: string) =>
  matchSearchToken(normalizeSearchText(query), prepareSearchText(haystack))?.score ?? null;

describe("sidebar session search matching", () => {
  it("normalizes accents and case", () => {
    expect(normalizeSearchText("Crème BRÛLÉE à la Café")).toBe("creme brulee a la cafe");
  });

  it("splits queries on whitespace after normalizing", () => {
    expect(tokenizeSearchQuery("  Résumé   Draft ")).toEqual(["resume", "draft"]);
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });

  it("matches accent-insensitive subsequences at original character positions", () => {
    expect(matchSearchToken("resu", prepareSearchText("Résumé review"))?.positions).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("returns no match for missing, longer, or empty tokens", () => {
    expect(matchSearchToken("xyz", prepareSearchText("Forge"))).toBeNull();
    expect(matchSearchToken("forged", prepareSearchText("Forge"))).toBeNull();
    expect(matchSearchToken("", prepareSearchText("Forge"))).toBeNull();
  });

  it("ranks word starts above matches buried inside words", () => {
    expect(score("pr", "Planning review")!).toBeGreaterThan(score("pr", "Compare notes")!);
    expect(score("for", "Forge")!).toBeGreaterThan(score("for", "Platform report")!);
  });

  it("ranks consecutive matches above scattered ones", () => {
    expect(score("docs", "Update docs")!).toBeGreaterThan(score("docs", "d o c s")!);
  });

  it("ranks prefix above word start above inner matches", () => {
    expect(score("gen", "General review")!).toBeGreaterThan(score("gen", "Weekly General")!);
    expect(score("gen", "Weekly General")!).toBeGreaterThan(score("gen", "Agenda")!);
  });

  it("requires every token and records the matched positions per field", () => {
    const fields = [prepareSearchText("Planning review"), prepareSearchText("Forge")];
    const match = scoreSearchFields(tokenizeSearchQuery("forge review"), fields);
    expect(match?.positions[1]).toEqual([0, 1, 2, 3, 4]);
    expect(match?.positions[0]).toEqual([9, 10, 11, 12, 13, 14]);
    expect(scoreSearchFields(tokenizeSearchQuery("forge harbor"), fields)).toBeNull();
  });

  it("prefers the shorter field on equal matches", () => {
    const short = scoreSearchFields(["docs"], [prepareSearchText("Docs")])!;
    const long = scoreSearchFields(
      ["docs"],
      [prepareSearchText("Docs checklist for the release")],
    )!;
    expect(short.score).toBeGreaterThan(long.score);
  });

  it("keeps positions aligned across multi-code-unit characters", () => {
    expect(matchSearchToken("ok", prepareSearchText("🚀 Ok ready"))?.positions).toEqual([2, 3]);
  });

  it("caps the gap penalty without losing far matches", () => {
    const near = matchSearchToken("kb", prepareSearchText("kxxxxxxb"));
    const far = matchSearchToken("kb", prepareSearchText("kxxxxxxxxxxxxxxxxxxxxb"));
    expect(far?.positions).toEqual([0, 21]);
    expect(near?.score).toBe(far?.score);
    expect(matchSearchToken("kb", prepareSearchText("kxxb"))!.score).toBeGreaterThan(near!.score);
  });

  it("uses the best far position rather than the latest one", () => {
    expect(matchSearchToken("ab", prepareSearchText("Ab xxa xxxxxxxxb"))?.positions).toEqual([
      0, 1,
    ]);
    expect(matchSearchToken("ab", prepareSearchText("Abx xxxxxxxxxx xb"))?.positions[0]).toBe(0);
  });
});
