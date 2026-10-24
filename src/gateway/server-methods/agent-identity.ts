import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateAgentIdentityParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolvePublicAgentAvatarSource } from "../../agents/identity-avatar.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import { resolveGatewayAssistantAvatar } from "../assistant-avatar.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// Workspace identity files and avatars change without a config event, so a
// response is only reused briefly; a new config object starts a fresh map.
const IDENTITY_RESPONSE_TTL_MS = 2_000;
const IDENTITY_RESPONSE_MAX_ENTRIES = 1_024;

type AgentIdentityResponse = Awaited<ReturnType<typeof resolveAssistantIdentity>> & {
  avatar: string;
  avatarSource?: string;
  avatarStatus?: string;
  avatarReason?: string;
};

const identityResponses = new WeakMap<
  OpenClawConfig,
  Map<string, { expiresAt: number; response: Promise<AgentIdentityResponse> }>
>();

async function buildAgentIdentityResponse(
  cfg: OpenClawConfig,
  agentId: string,
  httpBasePath: string | undefined,
): Promise<AgentIdentityResponse> {
  const identity = await resolveAssistantIdentity({ cfg, agentId });
  const avatarProjection = await resolveGatewayAssistantAvatar({ cfg, identity, httpBasePath });
  const avatarResolution = avatarProjection.resolution;
  return {
    ...identity,
    avatar: avatarProjection.avatar,
    avatarSource: avatarResolution ? resolvePublicAgentAvatarSource(avatarResolution) : undefined,
    avatarStatus: avatarResolution?.kind,
    avatarReason: avatarResolution?.kind === "none" ? avatarResolution.reason : undefined,
  };
}

function readAgentIdentityResponse(
  cfg: OpenClawConfig,
  agentId: string,
  httpBasePath: string | undefined,
): Promise<AgentIdentityResponse> {
  let responses = identityResponses.get(cfg);
  if (!responses) {
    responses = new Map();
    identityResponses.set(cfg, responses);
  }
  const key = JSON.stringify([agentId, httpBasePath ?? null]);
  const now = Date.now();
  const cached = responses.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.response;
  }
  const entry = {
    expiresAt: now + IDENTITY_RESPONSE_TTL_MS,
    response: buildAgentIdentityResponse(cfg, agentId, httpBasePath),
  };
  responses.delete(key);
  responses.set(key, entry);
  pruneMapToMaxSize(responses, IDENTITY_RESPONSE_MAX_ENTRIES);
  const settled = responses;
  entry.response.then(
    () => {
      entry.expiresAt = Date.now() + IDENTITY_RESPONSE_TTL_MS;
    },
    () => {
      if (settled.get(key) === entry) {
        settled.delete(key);
      }
    },
  );
  return entry.response;
}

export const agentIdentityGetHandler: GatewayRequestHandlers["agent.identity.get"] = async (
  options,
) => {
  const { params, respond, context, client } = options;
  if (!assertValidParams(params, validateAgentIdentityParams, "agent.identity.get", respond)) {
    return;
  }
  const agentIdRaw = normalizeOptionalString(params.agentId) ?? "";
  const sessionKeyRaw = normalizeOptionalString(params.sessionKey) ?? "";
  const cfg = context.getRuntimeConfig();
  let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (sessionKeyRaw && classifySessionKeyShape(sessionKeyRaw) === "malformed_agent") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid agent.identity.get params: malformed session key "${sessionKeyRaw}"`,
      ),
    );
    return;
  }
  if (sessionKeyRaw || !agentId) {
    const resolved = resolveRequestedSessionAgentId(cfg, sessionKeyRaw || "main", agentId);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    agentId = resolved.agentId;
  }
  const authority = readGatewayRequestMutationAuthority(options);
  const response = await readAgentIdentityResponse(
    cfg,
    agentId,
    client?.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI
      ? (cfg.gateway?.controlUi?.basePath ?? "")
      : undefined,
  );
  authority.assertCurrent();
  respond(true, { ...response }, undefined);
};

export const agentIdentityHandlers: GatewayRequestHandlers = {
  "agent.identity.get": agentIdentityGetHandler,
};
