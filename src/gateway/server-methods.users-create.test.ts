import type { IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { validateUsersCreateResult } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../state/user-profile-writes.js";
import { userProfilesDb } from "../state/user-profiles-internal.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  getUserProfileListItem,
  mergeProfiles,
  setUserProfileRole,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";

const cfg: OpenClawConfig = {
  gateway: {
    roles: {
      default: "member",
      definitions: {
        admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
        member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
      },
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function clientFor(profileId: string, scopes = ["operator.admin"]): GatewayClient {
  return {
    connId: `users-create-${profileId}`,
    authenticatedUserId: `${profileId}@example.test`,
    authenticatedUserProfile: { profileId, displayName: "Person", hasAvatar: false, updatedAt: 1 },
    connect: {
      role: "operator",
      scopes,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as GatewayClient;
}

function gateway() {
  const admin = ensureProfileForEmail("admin@example.test");
  setUserProfileRole(admin.id, "admin");
  const context = {
    getRuntimeConfig: () => cfg,
    logGateway: { warn: vi.fn() },
    broadcast: vi.fn(),
    refreshConnectedUserProfile: vi.fn(),
    disconnectClientsForUserProfile: vi.fn(),
  };
  const dispatch = async (params: unknown, client = clientFor(admin.id)) => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "users.create",
        method: "users.create",
        params,
        expectedProfileId: client.authenticatedUserProfile?.profileId,
      },
      respond,
      client,
      isWebchatConnect: () => false,
      context: context as unknown as GatewayRequestContext,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    return respond.mock.calls[0]!;
  };
  return { admin, context, dispatch };
}

function emailOwner(email: string): string | undefined {
  const { db } = openOpenClawStateDatabase();
  return executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_emails")
      .select("profile_id")
      .where("email", "=", email),
  ).rows[0]?.profile_id;
}

function profileCount(): number {
  const { db } = openOpenClawStateDatabase();
  return executeSqliteQuerySync(db, userProfilesDb(db).selectFrom("user_profiles").select("id"))
    .rows.length;
}

async function trustedProxyLogin(user: string) {
  const req = {
    headers: {},
    socket: { destroyed: false },
    aborted: false,
  } as unknown as IncomingMessage;
  const resolved = await resolveAuthenticatedHttpUserProfile({
    authResult: { ok: true, method: "trusted-proxy", user },
    cfg,
    getRuntimeConfig: () => cfg,
    req,
  });
  return resolved.authenticatedUserProfile?.profileId;
}

it("creates the profile a later login with that email resolves to", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
    expect((await rpc.dispatch({ email: "warmup@example.test" }))[0]).toBe(true);
    const before = profileCount();
    const queries = vi.spyOn(DatabaseSync.prototype, "prepare");
    let response: Awaited<ReturnType<typeof rpc.dispatch>>;
    try {
      response = await rpc.dispatch({ email: "Ada.Lovelace@Example.test" });
      expect(queries).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore();
    }
    expect(response[0], JSON.stringify(response[2])).toBe(true);
    expect(validateUsersCreateResult(response[1])).toBe(true);
    const { profile, created } = response[1] as {
      profile: { id: string; displayName: string | null; emails: string[]; role?: string };
      created: boolean;
    };
    expect(created).toBe(true);
    expect(profile).toMatchObject({
      displayName: "ada.lovelace",
      emails: ["ada.lovelace@example.test"],
    });
    expect(profile.role).toBeUndefined();
    expect(profileCount()).toBe(before + 1);
    expect(emailOwner("ada.lovelace@example.test")).toBe(profile.id);
    expect(rpc.context.broadcast).toHaveBeenCalledWith(
      "chat.metadata.changed",
      {},
      { dropIfSlow: true },
    );

    const repeat = await rpc.dispatch({
      email: "ada.lovelace@example.test",
      displayName: "Renamed",
    });
    expect(repeat[0], JSON.stringify(repeat[2])).toBe(true);
    expect(repeat[1]).toMatchObject({
      profile: { id: profile.id, displayName: "ada.lovelace" },
      created: false,
    });
    expect(validateUsersCreateResult(repeat[1])).toBe(true);

    expect(await trustedProxyLogin(" ADA.LOVELACE@example.test ")).toBe(profile.id);
    expect((await ensureCanonicalUserProfileForEmail("ada.lovelace@example.test")).id).toBe(
      profile.id,
    );
    const tailscale = await ensureCanonicalUserProfileForTailscaleIdentity({
      login: "Ada.Lovelace@example.test",
      name: "Tailscale Name",
    });
    expect(tailscale).toMatchObject({ id: profile.id, displayName: "ada.lovelace" });
    expect(profileCount()).toBe(before + 1);
  });
});

it("applies a display name only when it creates the profile", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
    const response = await rpc.dispatch({ email: "grace@example.test", displayName: " Grace " });
    expect(response[0], JSON.stringify(response[2])).toBe(true);
    expect(response[1]).toMatchObject({
      profile: { displayName: "Grace", emails: ["grace@example.test"] },
      created: true,
    });
    const id = (response[1] as { profile: { id: string } }).profile.id;
    const tailscale = await ensureCanonicalUserProfileForTailscaleIdentity({
      login: "grace@example.test",
      name: "Grace Hopper",
    });
    expect(tailscale).toMatchObject({ id, displayName: "Grace" });

    const existing = ensureProfileForEmail("linus@example.test");
    const unchanged = await rpc.dispatch({ email: "LINUS@example.test", displayName: "Other" });
    expect(unchanged[1]).toMatchObject({
      profile: { id: existing.id, displayName: "linus" },
      created: false,
    });
  });
});

it("follows profile merges to the surviving profile", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
    const source = ensureProfileForEmail("old@example.test");
    const target = ensureProfileForEmail("new@example.test");
    mergeProfiles(source.id, target.id);
    const response = await rpc.dispatch({ email: "old@example.test" });
    expect(response[1]).toMatchObject({ profile: { id: target.id }, created: false });
  });
});

it("refuses non-administrators, invalid emails, and the shared owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
    const before = profileCount();
    const denied = await rpc.dispatch(
      { email: "person@example.test" },
      clientFor(rpc.admin.id, ["operator.read", "operator.write"]),
    );
    expect(denied).toEqual([false, undefined, expect.objectContaining({ code: "FORBIDDEN" })]);
    expect(emailOwner("person@example.test")).toBeUndefined();

    for (const email of [
      "",
      "not-an-email",
      "person@localhost",
      "per son@example.test",
      " person@example.test",
      "a@b@example.test",
      "@example.test",
      "person@example.",
    ]) {
      const invalid = await rpc.dispatch({ email });
      expect(invalid, email).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      ]);
    }
    const unknownField = await rpc.dispatch({ email: "person@example.test", role: "admin" });
    expect(unknownField[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(profileCount()).toBe(before);

    ensureGatewayOwnerProfile(null);
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        userProfilesDb(db).insertInto("user_profile_emails").values({
          email: "owner@example.test",
          profile_id: GATEWAY_OWNER_PROFILE_ID,
          binding_id: "owner-binding",
          created_at: Date.now(),
        }),
      );
    });
    const owner = await rpc.dispatch({ email: "owner@example.test" });
    expect(owner).toEqual([false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" })]);
    expect(getUserProfileListItem(GATEWAY_OWNER_PROFILE_ID).emails).toEqual(["owner@example.test"]);
  });
});
