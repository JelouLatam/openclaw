import type { GatewayAgentRow } from "../../api/types.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../agents/display.ts";
import { normalizeAgentId } from "../sessions/session-key.ts";

/** Rows painted at once; the rest is a count, so large rosters never mount one avatar per agent. */
export const AGENT_MENTION_LIMIT = 8;

export type AgentMentionRoster = {
  agents: readonly GatewayAgentRow[];
  currentAgentId?: string | null;
};

export type AgentMentionMatch = { agent: GatewayAgentRow; label: string };

export type AgentMentionRanking = { matches: readonly AgentMentionMatch[]; overflow: number };

export const NO_AGENT_MENTIONS: AgentMentionRanking = { matches: [], overflow: 0 };

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function rank(id: string, label: string, query: string): number {
  if (id.startsWith(query)) {
    return 0;
  }
  if (label.startsWith(query)) {
    return 1;
  }
  if (label.split(/[\s-]+/u).some((word) => word.startsWith(query))) {
    return 2;
  }
  return id.includes(query) || label.includes(query) ? 3 : -1;
}

/** Agents the `@query` before the caret can name, best first: id prefix, name prefix, word start, substring. */
export function rankAgentMentions(
  roster: AgentMentionRoster | undefined,
  query: string,
): AgentMentionRanking {
  // Agent ids never contain other characters, so a wider query is a person's name.
  if (!roster || !/^[\w-]*$/u.test(query)) {
    return NO_AGENT_MENTIONS;
  }
  const currentAgentId = roster.currentAgentId ? normalizeAgentId(roster.currentAgentId) : null;
  const needle = fold(query);
  const ranked = listSelectableAgents(roster.agents)
    .filter((agent) => normalizeAgentId(agent.id) !== currentAgentId)
    .map((agent) => {
      const label = normalizeAgentLabel(agent);
      return { agent, label, rank: rank(fold(agent.id), fold(label), needle) };
    })
    .filter((entry) => entry.rank >= 0)
    .toSorted((a, b) => a.rank - b.rank);
  return {
    matches: ranked.slice(0, AGENT_MENTION_LIMIT).map(({ agent, label }) => ({ agent, label })),
    overflow: Math.max(0, ranked.length - AGENT_MENTION_LIMIT),
  };
}
