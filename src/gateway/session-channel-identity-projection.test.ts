import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../state/user-channel-identities.js";
import {
  ensureProfileForEmail,
  mergeProfiles,
  setAvatar,
  setDisplayName,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

const cfg = {} as OpenClawConfig;
const SENDER = "UA0NZD7C1";
const remoteSender = {
  type: "remote",
  pluginId: "slack",
  domain: "ta12bb21h",
  idKind: "user-id",
  id: SENDER.toLowerCase(),
} as const;

function slackEntry(
  chatType: "direct" | "channel",
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    sessionId: `slack-${chatType}`,
    updatedAt: 1,
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: SENDER },
    chatType,
    participants: [{ identity: remoteSender }],
    delivery: normalizeSessionDeliveryState({
      context: { channel: "slack", to: `user:${SENDER}` },
      origin: {
        provider: "slack",
        surface: "slack",
        chatType,
        from: chatType === "direct" ? `slack:${SENDER}` : "slack:channel:C0CHANNEL",
        to: chatType === "direct" ? `user:${SENDER}` : "channel:C0CHANNEL",
        accountId: "atlas",
        avatar: "/state/media/inbound/conversation-avatar.png",
      },
    }),
    ...overrides,
  };
}

function row(entry: SessionEntry, key = "agent:atlas:main:thread:1791243691.833009") {
  return buildGatewaySessionRow({
    cfg,
    agentId: "atlas",
    storePath: "",
    store: { [key]: entry },
    key,
    entry,
  });
}

function person(email: string, name: string, avatar = true) {
  const profile = ensureProfileForEmail(email);
  setDisplayName(profile.id, name);
  if (avatar) {
    expect(setAvatar(profile.id, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
  }
  return profile.id;
}

function link(profileId: string, accountId = "atlas", senderId = SENDER) {
  linkUserChannelIdentity(profileId, { channelId: "slack", accountId, senderId });
}

describe("linked channel identities in session rows", () => {
  it("leaves unlinked channel sessions on the legacy creator and the channel photo", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      person("someone@example.test", "Someone");
      const projected = row(slackEntry("direct"));
      expect(projected.createdActor).toEqual({
        type: "human",
        id: SENDER,
        identity: { type: "legacy", actorType: "human", source: null, id: SENDER },
      });
      expect(projected.participants).toEqual([{ identity: remoteSender }]);
      expect(projected.channelAvatarUrl).toMatch(/channel-avatar/);
      expect(projected.owner).toBeUndefined();
    });
  });

  it("projects a linked direct sender as their profile instead of the channel photo", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profileId = person("nicolas@example.test", "Nicolás Faccini");
      link(profileId);
      const projected = row(slackEntry("direct"));
      expect(projected.createdActor).toMatchObject({
        type: "human",
        id: SENDER,
        identity: { type: "profile", id: profileId },
        label: "Nicolás Faccini",
        avatarUrl: expect.stringContaining(encodeURIComponent(profileId)),
      });
      expect(projected.channelAvatarUrl).toBeUndefined();
      // The creator is the lead face, so the same person is not repeated as a participant.
      expect(projected.participants).toBeUndefined();
      // Display only: linking never assigns ownership.
      expect(projected.owner).toBeUndefined();
    });
  });

  it("keeps the channel photo when the linked person has no uploaded avatar", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profileId = person("plain@example.test", "Plain Person", false);
      link(profileId);
      const projected = row(slackEntry("direct"));
      expect(projected.createdActor?.identity).toEqual({ type: "profile", id: profileId });
      expect(projected.channelAvatarUrl).toMatch(/channel-avatar/);
    });
  });

  it("keeps the channel photo when a shared DM session's photo belongs to a later sender", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      link(person("first@example.test", "First Sender"));
      const entry = slackEntry("direct");
      const later = slackEntry("direct", {
        delivery: normalizeSessionDeliveryState({
          context: { channel: "slack", to: "user:U0LATER" },
          origin: {
            provider: "slack",
            chatType: "direct",
            from: "slack:U0LATER",
            accountId: "atlas",
            avatar: "/state/media/inbound/later.png",
          },
        }),
      });
      expect(row(entry).channelAvatarUrl).toBeUndefined();
      expect(row(later).channelAvatarUrl).toMatch(/channel-avatar/);
    });
  });

  it("follows a merged profile to its survivor", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = person("old@example.test", "Old Name");
      const survivor = person("new@example.test", "Survivor");
      link(source);
      mergeProfiles(source, survivor);
      const projected = row(slackEntry("direct"));
      expect(projected.createdActor).toMatchObject({
        identity: { type: "profile", id: survivor },
        label: "Survivor",
      });
    });
  });

  it("does not link a sender linked for another account", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      link(person("support@example.test", "Support Person"), "support");
      const projected = row(slackEntry("direct"));
      expect(projected.createdActor?.identity?.type).toBe("legacy");
      expect(projected.channelAvatarUrl).toMatch(/channel-avatar/);
    });
  });

  it("keeps the conversation image of a channel thread and links its participants", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const creator = person("creator@example.test", "Thread Creator");
      const guest = person("guest@example.test", "Guest");
      link(creator);
      link(guest, "support", "U0GUEST");
      const projected = row(
        slackEntry("channel", {
          participants: [
            { identity: remoteSender },
            { identity: { ...remoteSender, id: "u0guest" } },
            { identity: { ...remoteSender, id: "u0stranger" } },
          ],
        }),
      );
      expect(projected.createdActor?.identity).toEqual({ type: "profile", id: creator });
      expect(projected.channelAvatarUrl).toMatch(/channel-avatar/);
      expect(projected.participants).toEqual([
        expect.objectContaining({ identity: { type: "profile", id: guest }, label: "Guest" }),
        { identity: { ...remoteSender, id: "u0stranger" } },
      ]);
    });
  });

  it("does not fold the case of remote ids that carry case", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      link(person("cased@example.test", "Cased"), "atlas", "abc");
      const projected = row(
        slackEntry("channel", {
          createdActor: { type: "human", source: "channel", id: "U0OTHER" },
          participants: [{ identity: { ...remoteSender, id: "ABC" } }],
        }),
      );
      expect(projected.participants).toEqual([{ identity: { ...remoteSender, id: "ABC" } }]);
    });
  });

  it("projects a linked WhatsApp DM sender by the E.164 sender id the ingress verifies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const phone = "+593990000001";
      const profileId = person("ada@example.test", "Ada Lovelace");
      linkUserChannelIdentity(profileId, {
        channelId: "whatsapp",
        accountId: "atlas",
        senderId: phone,
      });
      const observation = {
        type: "observation",
        pluginId: "whatsapp",
        accountId: "atlas",
        senderKind: "unknown",
        id: phone,
      } as const;
      const projected = row({
        sessionId: "whatsapp-direct",
        updatedAt: 1,
        createdVia: "channel",
        createdActor: { type: "human", source: "channel", id: phone },
        chatType: "direct",
        participants: [{ identity: observation }],
        delivery: normalizeSessionDeliveryState({
          context: { channel: "whatsapp", to: phone },
          origin: { provider: "whatsapp", chatType: "direct", from: phone, accountId: "atlas" },
        }),
      });
      expect(projected.createdActor).toMatchObject({
        id: phone,
        identity: { type: "profile", id: profileId },
        label: "Ada Lovelace",
      });
      expect(projected.participants).toBeUndefined();
    });
  });

  it("refreshes materialized rows when a link is added or removed", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profileId = person("live@example.test", "Live Person");
      const key = "agent:main:main:thread:1791243691.833009";
      replaceSessionEntrySync({ agentId: "main", sessionKey: key }, slackEntry("direct"));
      const projection = await createSessionRowProjection({ cfg });
      const list = async () =>
        (await listProjectedSessions({ projection, opts: { limit: 10 } })).sessions.find(
          (session) => session.key === key,
        );
      expect((await list())?.createdActor?.identity?.type).toBe("legacy");
      link(profileId);
      const linked = await list();
      expect(linked?.createdActor?.identity).toEqual({ type: "profile", id: profileId });
      expect(linked?.channelAvatarUrl).toBeUndefined();
      unlinkUserChannelIdentity(profileId, {
        channelId: "slack",
        accountId: "atlas",
        senderId: SENDER,
      });
      const unlinked = await list();
      expect(unlinked?.createdActor?.identity?.type).toBe("legacy");
      expect(unlinked?.channelAvatarUrl).toMatch(/channel-avatar/);
    });
  });
});
