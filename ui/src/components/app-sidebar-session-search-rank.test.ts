import { describe, expect, it } from "vitest";
import { tokenizeSearchQuery } from "./app-sidebar-session-search-match.ts";
import { flattenSessionSearch, rankSessionSearch } from "./app-sidebar-session-search-rank.ts";

const agents = [
  { id: "forge", name: "Forge" },
  { id: "scout", name: "Scout" },
  { id: "harbor", name: "Harbor Café" },
];
const sessions = [
  { key: "agent:forge:dashboard:1", agentId: "forge", title: "Release notes", updatedAt: 3 },
  { key: "agent:forge:dashboard:2", agentId: "forge", title: "Release checklist", updatedAt: 2 },
  { key: "agent:forge:dashboard:3", agentId: "forge", title: "Proxy health check", updatedAt: 1 },
  {
    key: "agent:scout:dashboard:4",
    agentId: "scout",
    title: "Página de publicación",
    group: "Marketing",
    updatedAt: 5,
  },
  { key: "agent:harbor:main", agentId: "harbor", title: "Main chat", updatedAt: 4 },
];

describe("sidebar session search ranking", () => {
  it("lists every session of an agent whose name matches, matching sessions first", () => {
    const groups = rankSessionSearch({ tokens: tokenizeSearchQuery("forge"), agents, sessions });
    expect(groups.map((group) => group.agentId)).toEqual(["forge"]);
    expect(groups[0]?.highlight).toEqual([0, 1, 2, 3, 4]);
    expect(groups[0]?.sessions.map((hit) => hit.session.title)).toEqual([
      "Release notes",
      "Release checklist",
      "Proxy health check",
    ]);
  });

  it("highlights the agent for tokens that match its name on their own", () => {
    const groups = rankSessionSearch({
      tokens: tokenizeSearchQuery("forge release"),
      agents,
      sessions,
    });
    expect(groups.map((group) => group.agentId)).toEqual(["forge"]);
    expect(groups[0]?.agentMatch).toBeNull();
    expect(groups[0]?.highlight).toEqual([0, 1, 2, 3, 4]);
    expect(groups[0]?.sessions.map((hit) => hit.session.title)).toEqual([
      "Release notes",
      "Release checklist",
    ]);
  });

  it("matches titles, custom groups, and agent names without accents", () => {
    expect(
      rankSessionSearch({ tokens: tokenizeSearchQuery("publicacion"), agents, sessions }).map(
        (group) => group.agentId,
      ),
    ).toEqual(["scout"]);
    const byGroup = rankSessionSearch({ tokens: tokenizeSearchQuery("mark"), agents, sessions });
    expect(byGroup[0]?.sessions[0]?.match?.positions[2]).toEqual([0, 1, 2, 3]);
    expect(
      rankSessionSearch({ tokens: tokenizeSearchQuery("cafe main"), agents, sessions })[0]
        ?.sessions[0]?.session.key,
    ).toBe("agent:harbor:main");
  });

  it("flags rows that only the Gateway search returned", () => {
    const groups = rankSessionSearch({
      tokens: tokenizeSearchQuery("harbor"),
      agents,
      sessions,
      remoteKeys: new Set(["agent:harbor:main"]),
    });
    expect(groups[0]?.sessions[0]?.remote).toBe(true);
  });

  it("keeps agents that match without loaded sessions", () => {
    const groups = rankSessionSearch({
      tokens: tokenizeSearchQuery("scout"),
      agents,
      sessions: [],
    });
    expect(groups.map((group) => [group.agentId, group.sessions.length])).toEqual([["scout", 0]]);
  });

  it("interleaves every agent's matches when flattened", () => {
    const flat = flattenSessionSearch(
      rankSessionSearch({
        tokens: tokenizeSearchQuery("report"),
        agents,
        sessions: [
          {
            key: "agent:forge:dashboard:a",
            agentId: "forge",
            title: "Quarterly report",
            updatedAt: 1,
          },
          { key: "agent:scout:dashboard:b", agentId: "scout", title: "Report", updatedAt: 2 },
          {
            key: "agent:harbor:dashboard:c",
            agentId: "harbor",
            title: "Report",
            pinned: true,
            updatedAt: 0,
          },
        ],
      }),
    );
    expect(flat.map((hit) => [hit.agentName, hit.session.key])).toEqual([
      ["Harbor Café", "agent:harbor:dashboard:c"],
      ["Scout", "agent:scout:dashboard:b"],
      ["Forge", "agent:forge:dashboard:a"],
    ]);
  });
});
