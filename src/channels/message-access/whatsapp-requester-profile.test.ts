import { expect, it } from "vitest";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../state/user-channel-identity-operations.js";
import {
  ensureProfileForEmail,
  setDisplayName,
  setUserProfileRole,
} from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import type { ChannelPlugin } from "../plugins/types.public.js";
import { createCommandOwnerTestGateway } from "./operator-authority.test-support.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

type ReceivedMessage = {
  accountId: string;
  from: string;
  remoteJid: string;
  group?: boolean;
  senderE164: string | null;
  participantJid?: string;
  selfE164?: string;
  isFromMe?: boolean;
};

const ACCOUNT = "atlas";
const ADA = "+593990000001";
const SELF = "+593990000099";
const GROUP = "120363401234567890@g.us";
const UNRESOLVED_LID = "200000000000001@lid";

function requesterProfile(ctx: MsgContext | undefined) {
  if (!ctx) {
    throw new Error("Expected an admitted WhatsApp turn");
  }
  const prompt = buildInboundUserContextPrefix(ctx);
  return JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)![1]!).requester_profile;
}

it("binds a linked WhatsApp sender to its profile only from a verified phone principal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { whatsappPlugin } = await loadBundledPluginFacade<{ whatsappPlugin: ChannelPlugin }>({
      pluginId: "whatsapp",
      artifactBasename: "api.js",
    });
    const { receiveWhatsAppIngressIdentityTestMessage: receiveMessage } =
      await loadBundledPluginFacade<{
        receiveWhatsAppIngressIdentityTestMessage: (
          params: { cfg: OpenClawConfig; runtime: PluginRuntime },
          input: ReceivedMessage,
        ) => Promise<MsgContext | undefined>;
      }>({ pluginId: "whatsapp", artifactBasename: "ingress.test-api.js" });
    const previousRegistry = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" }]),
      null,
      "default",
    );
    let live = true;
    try {
      const cfg: OpenClawConfig = {
        channels: {
          whatsapp: {
            accounts: {
              [ACCOUNT]: {
                dmPolicy: "allowlist",
                allowFrom: [ADA, SELF],
                selfChatMode: true,
                groupPolicy: "open",
              },
            },
          },
        },
        gateway: {
          roles: {
            default: "member",
            definitions: {
              admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
              member: {
                scopes: ["operator.read", "operator.write"],
                agents: "*",
                sessions: { others: "view" },
              },
            },
          },
        },
      };
      const ada = ensureProfileForEmail("ada@example.test");
      setDisplayName(ada.id, "Ada Lovelace");
      setUserProfileRole(ada.id, "admin");
      for (const senderId of [ADA, UNRESOLVED_LID]) {
        linkUserChannelIdentity(ada.id, { channelId: "whatsapp", accountId: ACCOUNT, senderId });
      }
      const self = ensureProfileForEmail("self@example.test");
      linkUserChannelIdentity(self.id, {
        channelId: "whatsapp",
        accountId: ACCOUNT,
        senderId: SELF,
      });
      await publishCanonicalUserChannelPolicy(cfg.gateway, cfg.commands?.ownerAllowFrom);

      const gateway = createCommandOwnerTestGateway(cfg);
      const owner = {
        channelId: "whatsapp",
        isLive: () => live,
        resolveGatewayContext: () => gateway,
      };
      const runtime = createPluginRuntimeMock({
        channel: {
          inbound: {
            ingress: createHostChannelIngressRuntime(owner),
            buildContext: createHostChannelInboundEventContextBuilder(
              buildChannelInboundEventContext,
              owner,
            ) as PluginRuntime["channel"]["inbound"]["buildContext"],
          },
        },
      });
      const receive = (input: Omit<ReceivedMessage, "accountId">) =>
        receiveMessage({ cfg, runtime }, { accountId: ACCOUNT, selfE164: SELF, ...input });
      const isOwner = (ctx: MsgContext | undefined) =>
        resolveCommandAuthorization({ cfg, ctx: ctx!, commandAuthorized: true }).senderIsOwner;
      const linked = { id: ada.id, display_name: "Ada Lovelace" };

      const dm = await receive({
        from: ADA,
        remoteJid: "593990000001@s.whatsapp.net",
        senderE164: ADA,
      });
      expect(dm?.SenderId).toBe(ADA);
      expect(requesterProfile(dm)).toEqual(linked);
      expect(isOwner(dm)).toBe(true);

      const groupTurn = await receive({
        from: GROUP,
        remoteJid: GROUP,
        group: true,
        senderE164: ADA,
        participantJid: "100000000000001@lid",
      });
      expect(groupTurn?.SenderId).toBe(ADA);
      expect(requesterProfile(groupTurn)).toEqual(linked);

      const lidOnly = await receive({
        from: GROUP,
        remoteJid: GROUP,
        group: true,
        senderE164: null,
        participantJid: UNRESOLVED_LID,
      });
      expect(lidOnly?.SenderId).toBe(UNRESOLVED_LID);
      expect(requesterProfile(lidOnly)).toBeUndefined();
      expect(isOwner(lidOnly)).toBe(false);

      const selfChat = await receive({
        from: SELF,
        remoteJid: "593990000099@s.whatsapp.net",
        senderE164: SELF,
        isFromMe: true,
      });
      expect(selfChat?.SenderId).toBe(SELF);
      expect(requesterProfile(selfChat)).toBeUndefined();

      setUserProfileRole(ada.id, "member");
      const member = await receive({
        from: ADA,
        remoteJid: "593990000001@s.whatsapp.net",
        senderE164: ADA,
      });
      expect(requesterProfile(member)).toEqual(linked);
      expect(isOwner(member)).toBe(false);
    } finally {
      live = false;
      rollbackStagedPluginRegistry(previousRegistry);
    }
  });
});
