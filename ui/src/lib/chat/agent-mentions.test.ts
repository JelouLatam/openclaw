import { describe, expect, it } from "vitest";
import type { GatewayAgentRow } from "../../api/types.ts";
import { AGENT_MENTION_LIMIT, rankAgentMentions } from "./agent-mentions.ts";

const agent = (id: string, name?: string): GatewayAgentRow => (name ? { id, name } : { id });

function ranked(agents: readonly GatewayAgentRow[], query: string, currentAgentId = "main") {
  return rankAgentMentions({ agents, currentAgentId }, query).matches.map(
    (match) => match.agent.id,
  );
}

describe("agent mention ranking", () => {
  it("orders id prefix, name prefix, word start, then substring, keeping roster order within a rank", () => {
    const agents = [
      agent("zeta", "Release Opsbot"),
      agent("hops", "Hops"),
      agent("support", "Customer Ops"),
      agent("ops-two", "Second"),
      agent("orbit", "Opsdesk"),
      agent("ops-one", "First"),
      agent("unrelated", "Nothing"),
    ];
    expect(ranked(agents, "ops")).toEqual([
      "ops-two",
      "ops-one",
      "orbit",
      "zeta",
      "support",
      "hops",
    ]);
  });

  it("matches without case or accents and falls back to the identity name", () => {
    const agents = [
      agent("scout", "José Pérez"),
      { id: "pm", identity: { name: "Ángela Núñez" } },
      agent("ledger"),
    ];
    expect(ranked(agents, "PEREZ")).toEqual(["scout"]);
    expect(ranked(agents, "angela")).toEqual(["pm"]);
    expect(rankAgentMentions({ agents }, "led").matches).toEqual([
      { agent: agents[2], label: "ledger" },
    ]);
  });

  it("leaves out the current agent and system rows", () => {
    const agents = [agent("main"), agent("writer"), { id: "system-ops", kind: "system" as const }];
    expect(ranked(agents, "", "MAIN")).toEqual(["writer"]);
  });

  it("offers nothing for queries an agent id cannot hold", () => {
    const agents = [agent("scout", "José")];
    expect(ranked(agents, "jos")).toEqual(["scout"]);
    expect(ranked(agents, "josé")).toEqual([]);
    expect(ranked(agents, "scout.b")).toEqual([]);
    expect(rankAgentMentions(undefined, "scout")).toEqual({ matches: [], overflow: 0 });
  });

  it("caps the rows and reports the rest as overflow", () => {
    const agents = Array.from({ length: 300 }, (_, index) => agent(`agent-${index}`));
    const ranking = rankAgentMentions({ agents, currentAgentId: "main" }, "");
    expect(ranking.matches).toHaveLength(AGENT_MENTION_LIMIT);
    expect(ranking.overflow).toBe(300 - AGENT_MENTION_LIMIT);
    expect(rankAgentMentions({ agents }, "agent-29").matches.map((m) => m.agent.id)).toEqual([
      "agent-29",
      "agent-290",
      "agent-291",
      "agent-292",
      "agent-293",
      "agent-294",
      "agent-295",
      "agent-296",
    ]);
    expect(rankAgentMentions({ agents }, "agent-29").overflow).toBe(3);
  });
});
