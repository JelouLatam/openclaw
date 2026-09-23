import {
  matchSearchToken,
  prepareSearchText,
  scoreSearchFields,
  type FieldsMatch,
} from "./app-sidebar-session-search-match.ts";

export type SessionSearchCandidate = {
  readonly key: string;
  readonly agentId: string;
  readonly title: string;
  readonly group?: string;
  readonly pinned?: boolean;
  readonly updatedAt?: number | null;
};

export type SessionSearchAgent = { readonly id: string; readonly name: string };

/** Field order of `match.positions`: title, agent name, custom group. */
export type SessionSearchHit<T extends SessionSearchCandidate> = {
  session: T;
  match: FieldsMatch | null;
  remote: boolean;
};

export type SessionSearchGroup<T extends SessionSearchCandidate> = {
  agentId: string;
  name: string;
  /** Set when every token matches the agent name; the agent then lists all its sessions. */
  agentMatch: FieldsMatch | null;
  /** Name positions matched by any single token, so `harbor notes` still marks the agent. */
  highlight: number[];
  sessions: SessionSearchHit<T>[];
  score: number;
};

export type FlatSessionSearchHit<T extends SessionSearchCandidate> = SessionSearchHit<T> & {
  agentId: string;
  agentName: string;
  score: number;
};

export function rankSessionSearch<T extends SessionSearchCandidate>(params: {
  tokens: readonly string[];
  agents: readonly SessionSearchAgent[];
  sessions: readonly T[];
  remoteKeys?: ReadonlySet<string>;
}): SessionSearchGroup<T>[] {
  const { tokens } = params;
  const agentsById = new Map(params.agents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, SessionSearchGroup<T>>();
  const groupFor = (agentId: string): SessionSearchGroup<T> => {
    const existing = groups.get(agentId);
    if (existing) {
      return existing;
    }
    const name = agentsById.get(agentId)?.name || agentId;
    const prepared = prepareSearchText(name);
    const agentMatch = scoreSearchFields(tokens, [prepared]);
    const highlight = [
      ...new Set(tokens.flatMap((token) => matchSearchToken(token, prepared)?.positions ?? [])),
    ].toSorted((a, b) => a - b);
    const group: SessionSearchGroup<T> = {
      agentId,
      name,
      agentMatch,
      highlight,
      sessions: [],
      score: agentMatch?.score ?? Number.NEGATIVE_INFINITY,
    };
    groups.set(agentId, group);
    return group;
  };
  for (const agent of params.agents) {
    groupFor(agent.id);
  }
  for (const session of params.sessions) {
    if (!session.agentId) {
      continue;
    }
    const group = groupFor(session.agentId);
    const match = scoreSearchFields(tokens, [
      prepareSearchText(session.title),
      prepareSearchText(group.name),
      prepareSearchText(session.group ?? ""),
    ]);
    if (!match && !group.agentMatch) {
      continue;
    }
    group.sessions.push({
      session,
      match,
      remote: params.remoteKeys?.has(session.key) === true,
    });
    if (match && match.score > group.score) {
      group.score = match.score;
    }
  }
  const ranked = [...groups.values()].filter(
    (group) => group.agentMatch !== null || group.sessions.length > 0,
  );
  for (const group of ranked) {
    group.sessions.sort((a, b) => {
      const scoreA = a.match?.score ?? Number.NEGATIVE_INFINITY;
      const scoreB = b.match?.score ?? Number.NEGATIVE_INFINITY;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
    });
  }
  return ranked.toSorted((a, b) => b.score - a.score);
}

/** Interleave every agent's matches into one list, best match first. */
export function flattenSessionSearch<T extends SessionSearchCandidate>(
  groups: readonly SessionSearchGroup<T>[],
): FlatSessionSearchHit<T>[] {
  return groups
    .flatMap((group) =>
      group.sessions.map((hit) => ({
        ...hit,
        agentId: group.agentId,
        agentName: group.name,
        score: hit.match?.score ?? group.agentMatch?.score ?? Number.NEGATIVE_INFINITY,
      })),
    )
    .toSorted((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      const pinned = Number(b.session.pinned === true) - Number(a.session.pinned === true);
      if (pinned !== 0) {
        return pinned;
      }
      const updated = (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
      return updated !== 0 ? updated : a.session.title.localeCompare(b.session.title);
    });
}
