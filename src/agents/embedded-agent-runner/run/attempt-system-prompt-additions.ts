import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import { resolveSessionGitCoauthorPrompt } from "../../git-coauthor-prompt.js";
import { appendIncognitoSystemPrompt } from "../../incognito-system-prompt.js";
import { appendProgressCardSystemPrompt } from "../../progress-card-system-prompt.js";
import type { EmbeddedRunTrigger } from "../../run-trigger.js";
import type { SilentReplyPromptMode } from "../../system-prompt.types.js";
import { resolveEmbeddedSessionConversationContext } from "../session-prompt-state.js";

/** Prepares host-owned additions before either embedded or plugin harness dispatch. */
export async function prepareAttemptSystemPromptAdditions(params: {
  agentId: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  extraSystemPrompt?: string;
  inputProvenance?: InputProvenance;
  modelId: string;
  provider: string;
  sessionId: string;
  sessionKey?: string;
  silentReplyPromptMode?: SilentReplyPromptMode;
  storePath?: string;
  toolsAllow?: string[];
  trigger?: EmbeddedRunTrigger;
}) {
  const conversation = resolveEmbeddedSessionConversationContext(params);
  const extraSystemPrompt = await appendProgressCardSystemPrompt({
    ...params,
    extraSystemPrompt: appendIncognitoSystemPrompt({
      ...params,
      extraSystemPrompt: conversation.extraSystemPrompt,
    }),
  });
  const gitCoauthorPrompt = await resolveSessionGitCoauthorPrompt({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storePath: params.storePath,
  });
  // Credit has its own retained prompt placement; do not fold it into dynamic additions.
  return {
    extraSystemPrompt,
    gitCoauthorPrompt,
    silentReplyPromptMode: conversation.silentReplyPromptMode,
  };
}
