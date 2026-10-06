import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionCreatedActor,
  SessionParticipant,
} from "../../packages/gateway-protocol/src/index.js";
import type {
  InternalSessionEntry as SessionEntry,
  SessionOrigin,
} from "../config/sessions/types.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import { listAllUserChannelIdentityLinks } from "../state/user-channel-identities.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { projectSessionParticipant } from "./session-identity-projection.js";
import type { SessionActorProfileIdentity } from "./session-utils-contracts.js";

type ProfileIdentities = Map<string, SessionActorProfileIdentity | undefined>;

type ChannelIdentityLinkIndex = {
  bySubject: Map<string, string>;
  bySender: Map<string, Set<string>>;
  byFoldedSender: Map<string, Set<string>>;
};

const EMPTY_INDEX: ChannelIdentityLinkIndex = {
  bySubject: new Map(),
  bySender: new Map(),
  byFoldedSender: new Map(),
};

// Link and unlink publish a profile change, so the profile version retires stale snapshots.
const indexes = new WeakMap<
  ProfileIdentities,
  { version: number; index: ChannelIdentityLinkIndex }
>();

function subjectKey(channelId: string, accountId: string, senderId: string) {
  return JSON.stringify([channelId, accountId, senderId]);
}

function addTo(map: Map<string, Set<string>>, key: string, profileId: string) {
  let profiles = map.get(key);
  if (!profiles) {
    profiles = new Set();
    map.set(key, profiles);
  }
  profiles.add(profileId);
}

function buildIndex(): ChannelIdentityLinkIndex {
  let links: ReturnType<typeof listAllUserChannelIdentityLinks>;
  try {
    links = listAllUserChannelIdentityLinks();
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      throw error;
    }
    // Display enrichment must never fail the session list.
    return EMPTY_INDEX;
  }
  if (links.length === 0) {
    return EMPTY_INDEX;
  }
  const index: ChannelIdentityLinkIndex = {
    bySubject: new Map(),
    bySender: new Map(),
    byFoldedSender: new Map(),
  };
  for (const { profileId, identity } of links) {
    const { channelId, accountId, senderId } = identity;
    index.bySubject.set(subjectKey(channelId, accountId, senderId), profileId);
    addTo(index.bySender, `${channelId}\0${senderId}`, profileId);
    addTo(index.byFoldedSender, `${channelId}\0${senderId.toLowerCase()}`, profileId);
  }
  return index;
}

function readIndex(identities: ProfileIdentities): ChannelIdentityLinkIndex {
  const version = readUserProfileVersion();
  const cached = indexes.get(identities);
  if (cached?.version === version) {
    return cached.index;
  }
  const index = buildIndex();
  indexes.set(identities, { version, index });
  return index;
}

function resolveProfile(
  profileId: string,
  identities: ProfileIdentities,
): SessionActorProfileIdentity | undefined {
  if (!identities.has(profileId)) {
    const display = resolveCurrentUserProfileDisplay(profileId);
    identities.set(profileId, display.kind === "resolved" ? display : undefined);
  }
  return identities.get(profileId);
}

/** Accounts may link one sender to different people; only an unambiguous live person projects. */
function resolveUniqueProfile(
  profileIds: Iterable<string> | undefined,
  identities: ProfileIdentities,
): string | undefined {
  let resolved: string | undefined;
  for (const id of profileIds ?? []) {
    const profileId = resolveProfile(id, identities)?.profileId;
    if (!profileId || (resolved && resolved !== profileId)) {
      return undefined;
    }
    resolved = profileId;
  }
  return resolved;
}

/** Display only: a linked channel creator never gains profile provenance or ownership. */
export function projectLinkedSessionCreator(
  entry: SessionEntry | undefined,
  origin: SessionOrigin | undefined,
  identities: ProfileIdentities,
): SessionCreatedActor | undefined {
  const actor = entry?.createdActor;
  if (actor?.type !== "human" || actor.source !== "channel") {
    return undefined;
  }
  const senderId = normalizeOptionalString(actor.id);
  const channelId = normalizeOptionalString(origin?.provider);
  if (!senderId || !channelId) {
    return undefined;
  }
  const accountId = normalizeOptionalString(origin?.accountId) ?? DEFAULT_ACCOUNT_ID;
  const linked = readIndex(identities).bySubject.get(subjectKey(channelId, accountId, senderId));
  const profileId = linked ? resolveUniqueProfile([linked], identities) : undefined;
  if (!profileId) {
    return undefined;
  }
  return {
    type: "human",
    id: senderId,
    ...projectSessionParticipant({ type: "profile", id: profileId }, identities),
  };
}

function linkedParticipantProfileId(
  participant: SessionParticipant,
  identities: ProfileIdentities,
): string | undefined {
  const { identity } = participant;
  if (identity.type === "observation") {
    if (!identity.pluginId) {
      return undefined;
    }
    const linked = readIndex(identities).bySubject.get(
      subjectKey(identity.pluginId, identity.accountId ?? DEFAULT_ACCOUNT_ID, identity.id),
    );
    return linked ? resolveUniqueProfile([linked], identities) : undefined;
  }
  if (identity.type !== "remote") {
    return undefined;
  }
  const index = readIndex(identities);
  const exact = index.bySender.get(`${identity.pluginId}\0${identity.id}`);
  if (exact) {
    return resolveUniqueProfile(exact, identities);
  }
  // Remote ids carry no account; channels that fold sender ids (Slack) store them lowercased
  // while links keep the native casing. A cased remote id proves case-sensitive semantics.
  return identity.id === identity.id.toLowerCase()
    ? resolveUniqueProfile(
        index.byFoldedSender.get(`${identity.pluginId}\0${identity.id}`),
        identities,
      )
    : undefined;
}

/** Display only: linked remote faces render as the person; stored participation is unchanged. */
export function linkSessionChannelParticipant(
  participant: SessionParticipant,
  identities: ProfileIdentities,
): SessionParticipant {
  const profileId = linkedParticipantProfileId(participant, identities);
  return profileId
    ? projectSessionParticipant({ type: "profile", id: profileId }, identities)
    : participant;
}

/**
 * A direct conversation's channel image is the sender's own photo, so a linked creator with an
 * uploaded avatar replaces it. Group and channel images belong to the conversation and stay.
 */
export function linkedCreatorReplacesChannelAvatar(
  entry: SessionEntry | undefined,
  origin: SessionOrigin | undefined,
  createdActor: SessionCreatedActor | undefined,
): boolean {
  const senderId = normalizeOptionalString(entry?.createdActor?.id);
  if (
    entry?.createdActor?.type !== "human" ||
    entry.createdActor.source !== "channel" ||
    !senderId ||
    createdActor?.identity?.type !== "profile" ||
    !createdActor.avatarUrl ||
    (entry.chatType ?? origin?.chatType) !== "direct"
  ) {
    return false;
  }
  // A shared DM session (dmScope "main") can carry a later sender's photo.
  const from = normalizeOptionalString(origin?.from);
  return from !== undefined && (from === senderId || from.endsWith(`:${senderId}`));
}
