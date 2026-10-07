import { validateChatSendParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { shouldDefaultSessionWorktree } from "../session-worktree-default.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/**
 * A person's first `chat.send` to a key with no row creates that session. With
 * `worktreeNewSessions`, create it through `sessions.create` first so it gets the same worktree
 * default as every other session a person starts. Returns false after responding with the error.
 */
export async function createDefaultWorktreeSessionForChatSend(
  options: GatewayRequestHandlerOptions,
): Promise<boolean> {
  const cfg = options.context.getRuntimeConfig();
  if (cfg.worktreeNewSessions !== true || !validateChatSendParams(options.params)) {
    return true;
  }
  const { sessionKey, agentId, sessionId } = options.params as Record<string, unknown>;
  const rawKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (
    !rawKey ||
    rawKey.toLowerCase() === "global" ||
    isIncognitoSessionKey(rawKey) ||
    (typeof sessionId === "string" && sessionId.trim())
  ) {
    return true;
  }
  const requested = resolveRequestedSessionAgentId(
    cfg,
    rawKey,
    typeof agentId === "string" ? agentId : undefined,
  );
  if (!requested.ok) {
    return true;
  }
  const loaded = loadGatewaySessionEntryReadOnly(rawKey, { agentId: requested.agentId });
  if (
    !shouldDefaultSessionWorktree({
      cfg,
      request: {},
      agentId: requested.agentId,
      via: resolveOperatorSessionCreation(options.client, { allowTrustedHint: true }).via,
      existingSession: Boolean(loaded.entry),
      mainSession:
        loaded.canonicalKey === resolveAgentMainSessionKey({ cfg, agentId: requested.agentId }),
    })
  ) {
    return true;
  }
  const { createSessionForSend } = await import("./sessions-messaging.js");
  const created = await createSessionForSend(options, loaded.canonicalKey);
  if (!created.ok) {
    options.respond(false, undefined, created.error);
    return false;
  }
  return true;
}
