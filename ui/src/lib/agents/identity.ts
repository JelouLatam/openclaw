import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";

type AgentIdentityGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  phase: ApplicationGatewayPhase;
};

type AgentIdentityGateway = {
  readonly snapshot: AgentIdentityGatewaySnapshot;
  subscribe: (listener: (snapshot: AgentIdentityGatewaySnapshot) => void) => () => void;
  subscribeEvents?: (listener: (event: { event: string }) => void) => () => void;
};

type AgentIdentityCacheEntry = {
  pending: Promise<AgentIdentityResult | null>;
  result?: { identity: AgentIdentityResult | null; cachedAt: number };
};

const AGENT_IDENTITY_CACHE_LIMIT = 128;
// Workspace avatars can change in place without a config or roster event.
const AGENT_IDENTITY_CACHE_TTL_MS = 60_000;
// A failed read publishes nothing, so without a floor every render retries it.
const AGENT_IDENTITY_RETRY_FLOOR_MS = 5_000;
const identityRequests = new WeakMap<GatewayBrowserClient, Map<string, AgentIdentityCacheEntry>>();

/** Retire every UI surface's cached request when its connection or roster revision changes. */
function invalidateAgentIdentityCache(
  client: GatewayBrowserClient | null,
  agentIds?: readonly string[],
): void {
  if (!client) {
    return;
  }
  if (agentIds) {
    const cache = identityRequests.get(client);
    for (const agentId of agentIds) {
      cache?.delete(agentId);
    }
  } else {
    identityRequests.delete(client);
  }
}

function hasFreshAgentIdentityResult(entry: AgentIdentityCacheEntry | undefined): boolean {
  return Boolean(entry?.result && Date.now() - entry.result.cachedAt < AGENT_IDENTITY_CACHE_TTL_MS);
}

export function fetchAgentIdentity(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<AgentIdentityResult | null> {
  let cache = identityRequests.get(client);
  if (!cache) {
    cache = new Map();
    identityRequests.set(client, cache);
  }
  const key = agentId.trim();
  const cached = cache.get(key);
  if (cached && (!cached.result || hasFreshAgentIdentityResult(cached))) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.pending;
  }
  cache.delete(key);
  const entry: AgentIdentityCacheEntry = { pending: Promise.resolve(null) };
  entry.pending = client
    .request<AgentIdentityResult | null>("agent.identity.get", { agentId: key })
    .then(
      (identity) => {
        if (identityRequests.get(client) !== cache || cache.get(key) !== entry) {
          return null;
        }
        entry.result = { identity, cachedAt: Date.now() };
        for (const [id, candidate] of cache) {
          if (cache.size <= AGENT_IDENTITY_CACHE_LIMIT) {
            break;
          }
          if (candidate.result) {
            cache.delete(id);
          }
        }
        return identity;
      },
      (error: unknown) => {
        if (cache.get(key) === entry) {
          cache.delete(key);
        }
        throw error;
      },
    );
  cache.set(key, entry);
  return entry.pending;
}

export type AgentIdentityCapability = {
  get: (agentId: string | null | undefined) => AgentIdentityResult | null;
  entries: () => AgentIdentityResult[];
  ensure: (agentIds: readonly (string | null | undefined)[]) => Promise<void>;
  invalidate: (agentIds: readonly (string | null | undefined)[]) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createAgentIdentityCapability(
  gateway: AgentIdentityGateway,
): AgentIdentityCapability {
  let cachedClient: GatewayBrowserClient | null = gateway.snapshot.client;
  let cachedConnected = gateway.snapshot.phase === "connected";
  let connectionGeneration = 0;
  const identities = new Map<string, AgentIdentityResult>();
  const publishedAt = new Map<string, number>();
  const retryAt = new Map<string, number>();
  const invalidationEpochs = new Map<string, number>();
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const resetForGateway = (snapshot: AgentIdentityGatewaySnapshot) => {
    const connected = snapshot.phase === "connected";
    if (snapshot.client === cachedClient && connected === cachedConnected) {
      return;
    }
    const hadIdentities = identities.size > 0;
    invalidateAgentIdentityCache(cachedClient);
    cachedClient = snapshot.client;
    cachedConnected = connected;
    connectionGeneration += 1;
    identities.clear();
    publishedAt.clear();
    retryAt.clear();
    invalidationEpochs.clear();
    if (hadIdentities) {
      publish();
    }
  };

  gateway.subscribe(resetForGateway);

  gateway.subscribeEvents?.((event) => {
    if (event.event !== "config.changed") {
      return;
    }
    invalidateAgentIdentityCache(cachedClient);
    connectionGeneration += 1;
    identities.clear();
    publishedAt.clear();
    retryAt.clear();
    invalidationEpochs.clear();
    publish();
  });

  return {
    get(agentId) {
      const normalized = agentId?.trim();
      return normalized ? (identities.get(normalized) ?? null) : null;
    },
    entries() {
      return [...identities.values()];
    },
    async ensure(agentIds) {
      const snapshot = gateway.snapshot;
      resetForGateway(snapshot);
      const client = snapshot.client;
      if (!client || snapshot.phase !== "connected") {
        return;
      }
      const generation = connectionGeneration;
      const now = Date.now();
      const missing = normalizeUniqueTrimmedStringList(agentIds).filter((agentId) => {
        if ((retryAt.get(agentId) ?? 0) > now) {
          return false;
        }
        const cached = identityRequests.get(client)?.get(agentId);
        if (cached) {
          return (
            !hasFreshAgentIdentityResult(cached) ||
            identities.get(agentId) !== cached.result?.identity
          );
        }
        // The shared cache evicts beyond its limit; a roster larger than it
        // would otherwise refetch the evicted ids on every publication.
        const at = publishedAt.get(agentId);
        return at === undefined || now - at >= AGENT_IDENTITY_CACHE_TTL_MS;
      });
      if (missing.length === 0) {
        return;
      }
      const results = await Promise.all(
        missing.map(async (agentId) => {
          const invalidationEpoch = invalidationEpochs.get(agentId) ?? 0;
          return [
            agentId,
            invalidationEpoch,
            await fetchAgentIdentity(client, agentId).catch(() => null),
          ] as const;
        }),
      );
      if (
        connectionGeneration !== generation ||
        gateway.snapshot.client !== client ||
        gateway.snapshot.phase !== "connected"
      ) {
        return;
      }
      let changed = false;
      for (const [agentId, invalidationEpoch, identity] of results) {
        if (!identity) {
          if (invalidationEpoch === (invalidationEpochs.get(agentId) ?? 0)) {
            retryAt.set(agentId, Date.now() + AGENT_IDENTITY_RETRY_FLOOR_MS);
          }
          continue;
        }
        retryAt.delete(agentId);
        // Overlapping ensure calls share the request, so only its first
        // publication changes the snapshot observed by subscribers.
        if (
          identity &&
          identities.get(agentId) !== identity &&
          invalidationEpoch === (invalidationEpochs.get(agentId) ?? 0)
        ) {
          identities.set(agentId, identity);
          publishedAt.set(agentId, Date.now());
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
    invalidate(agentIds) {
      let changed = false;
      const ids = normalizeUniqueTrimmedStringList(agentIds);
      invalidateAgentIdentityCache(cachedClient, ids);
      for (const agentId of ids) {
        invalidationEpochs.set(agentId, (invalidationEpochs.get(agentId) ?? 0) + 1);
        publishedAt.delete(agentId);
        retryAt.delete(agentId);
        if (identities.delete(agentId)) {
          changed = true;
        }
      }
      if (changed) {
        publish();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
