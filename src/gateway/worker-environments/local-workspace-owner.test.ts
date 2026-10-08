import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveLocalWorkspaceOwner } from "./local-workspace-projection.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

async function spawnedWorktreeChild() {
  const root = tempDirs.make("openclaw-local-workspace-owner-");
  const stateDir = path.join(root, "state");
  const agentWorkspace = path.join(root, "workspaces", "main");
  const worktreePath = path.join(stateDir, "worktrees", "repo", "child");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const sessionKey = "agent:main:dashboard:child";
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true, workspace: agentWorkspace }] },
    session: { store: storePath },
  };
  insertRegistryWorktree(env, {
    id: "child",
    name: "child",
    repoFingerprint: "0123456789abcdef",
    repoRoot: agentWorkspace,
    path: worktreePath,
    branch: "openclaw/child",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  });
  await replaceSessionEntry(
    { agentId: "main", env, sessionKey, storePath },
    {
      sessionId: "child-session",
      updatedAt: 10,
      spawnedCwd: worktreePath,
      worktree: {
        id: "child",
        branch: "openclaw/child",
        repoRoot: agentWorkspace,
        canonicalWorkspaceDir: agentWorkspace,
      },
    },
  );
  return { cfg, env, sessionKey, agentWorkspace, worktreePath, root };
}

it("binds a spawned worktree child whose run passes the agent's recorded workspace", async () => {
  const child = await spawnedWorktreeChild();
  for (const workspaceDir of [child.agentWorkspace, child.worktreePath, undefined]) {
    const owner = resolveLocalWorkspaceOwner({
      cfg: child.cfg,
      env: child.env,
      agentId: "main",
      sessionKey: child.sessionKey,
      workspaceDir,
    });
    expect(owner?.worktree.path).toBe(child.worktreePath);
  }
});

it("still refuses a workspace the session never recorded", async () => {
  const child = await spawnedWorktreeChild();
  expect(() =>
    resolveLocalWorkspaceOwner({
      cfg: child.cfg,
      env: child.env,
      agentId: "main",
      sessionKey: child.sessionKey,
      workspaceDir: path.join(child.root, "elsewhere"),
    }),
  ).toThrow("Local sandbox managed workspace owner changed");
});
