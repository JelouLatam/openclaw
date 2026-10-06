import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { prepareWhatsAppInboundContext } from "../auto-reply/monitor/inbound-dispatch.js";
import { getPrimaryIdentityId, resolveComparableIdentity } from "../identity.js";
import { setWhatsAppRuntime } from "../runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

export type WhatsAppIngressIdentityTestMessage = {
  accountId: string;
  /** Normalized like the Baileys listener: E.164 for DMs, group JID for groups. */
  from: string;
  remoteJid: string;
  group?: boolean;
  senderE164: string | null;
  participantJid?: string;
  selfE164?: string;
  isFromMe?: boolean;
};

/** Real access control and context preparation; sender facts match the Baileys normalizer. */
export async function receiveWhatsAppIngressIdentityTestMessage(
  params: { cfg: OpenClawConfig; runtime: PluginRuntime },
  input: WhatsAppIngressIdentityTestMessage,
): Promise<FinalizedMsgContext | undefined> {
  setWhatsAppRuntime(params.runtime);
  const group = input.group === true;
  const access = await checkInboundAccessControl({
    cfg: params.cfg,
    accountId: input.accountId,
    from: input.from,
    selfE164: input.selfE164 ?? "+15550009999",
    senderE164: input.senderE164,
    senderJid: input.participantJid,
    group,
    isFromMe: input.isFromMe === true,
    remoteJid: input.remoteJid,
    sock: { sendMessage: async () => undefined },
  });
  if (!access.allowed) {
    return undefined;
  }
  const sender = resolveComparableIdentity({
    jid: input.participantJid,
    e164: input.senderE164 ?? undefined,
  });
  const msg = createTestWebInboundMessage({
    platform: {
      chatJid: input.remoteJid,
      sender,
      senderJid: input.participantJid,
      senderE164: input.senderE164 ?? undefined,
      fromMe: input.isFromMe === true,
    },
  });
  msg.admission = access.admission;
  const conversationKind = group ? "group" : "direct";
  const prepared = await prepareWhatsAppInboundContext({
    combinedBody: "hello",
    msg,
    sender: {
      id: getPrimaryIdentityId(sender) ?? undefined,
      e164: sender.e164 ?? undefined,
    },
    route: {
      agentId: "main",
      channel: "whatsapp",
      accountId: input.accountId,
      sessionKey: `agent:main:whatsapp:${conversationKind}:${input.from}`,
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    buildContext: params.runtime.channel.inbound.buildContext,
  });
  return prepared.ctxPayload;
}
