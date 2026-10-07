import type { SessionsCreateParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { insideGitCheckout } from "../agents/worktrees/git.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * With `worktreeNewSessions`, a person's new session for an agent whose workspace is a Git
 * checkout starts in a managed worktree of that workspace instead of on the shared checkout.
 */
export function shouldDefaultSessionWorktree(params: {
  cfg: OpenClawConfig;
  request: SessionsCreateParams;
  agentId: string;
  via: string;
  existingSession: boolean;
  mainSession: boolean;
}): boolean {
  const { cfg, request } = params;
  if (cfg.worktreeNewSessions !== true || params.via !== "operator") {
    return false;
  }
  if (params.existingSession || params.mainSession || request.worktree !== undefined) {
    return false;
  }
  const otherSource =
    request.cwd ||
    request.projectId ||
    request.projectGitUrl ||
    request.repository ||
    request.execNode ||
    request.worktreeSource ||
    request.catalogId ||
    request.fork ||
    request.forkFrom ||
    (request.parentSessionKey && !isLineageOnlyParent(params)) ||
    request.incognito;
  if (otherSource) {
    return false;
  }
  return insideGitCheckout(resolveAgentWorkspaceDir(cfg, params.agentId));
}

/** The chat pane's `/new` names its parent for lineage only; that is not a workspace choice. */
function isLineageOnlyParent(params: {
  cfg: OpenClawConfig;
  request: SessionsCreateParams;
  agentId: string;
}): boolean {
  const { request } = params;
  return (
    request.emitCommandHooks === true &&
    request.succeedsParent === false &&
    request.parentSessionKey?.trim().toLowerCase() !==
      resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId }).toLowerCase()
  );
}
