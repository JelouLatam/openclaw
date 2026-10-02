import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldDefaultSessionWorktree } from "./session-worktree-default.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workspaces() {
  const root = tempDirs.make("openclaw-session-worktree-default-");
  const repo = path.join(root, "client");
  const plain = path.join(root, "atlas");
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  execFileSync("git", ["init", "-q", repo]);
  return { repo, plain };
}

function config(enabled: boolean | undefined): OpenClawConfig {
  const { repo, plain } = workspaces();
  return {
    ...(enabled === undefined ? {} : { worktreeNewSessions: enabled }),
    agents: {
      entries: {
        client: { workspace: repo },
        atlas: { workspace: plain },
      },
    },
  } as OpenClawConfig;
}

const person = {
  agentId: "client",
  via: "operator",
  existingSession: false,
  mainSession: false,
};

describe("shouldDefaultSessionWorktree", () => {
  it("starts a person's new session of a Git-workspace agent in a worktree", () => {
    expect(
      shouldDefaultSessionWorktree({ ...person, cfg: config(true), request: { message: "hi" } }),
    ).toBe(true);
  });

  it("is off unless worktreeNewSessions is true", () => {
    expect(shouldDefaultSessionWorktree({ ...person, cfg: config(undefined), request: {} })).toBe(
      false,
    );
    expect(shouldDefaultSessionWorktree({ ...person, cfg: config(false), request: {} })).toBe(
      false,
    );
  });

  it("leaves an agent whose workspace is not a Git checkout alone", () => {
    expect(
      shouldDefaultSessionWorktree({ ...person, agentId: "atlas", cfg: config(true), request: {} }),
    ).toBe(false);
  });

  it("leaves spawned, run-created, existing and main sessions alone", () => {
    const cfg = config(true);
    expect(shouldDefaultSessionWorktree({ ...person, cfg, via: "spawn", request: {} })).toBe(false);
    expect(shouldDefaultSessionWorktree({ ...person, cfg, via: "run", request: {} })).toBe(false);
    expect(
      shouldDefaultSessionWorktree({ ...person, cfg, existingSession: true, request: {} }),
    ).toBe(false);
    expect(shouldDefaultSessionWorktree({ ...person, cfg, mainSession: true, request: {} })).toBe(
      false,
    );
  });

  it("respects an explicit worktree choice and every other workspace source", () => {
    const cfg = config(true);
    const others = [
      { worktree: false },
      { worktree: true },
      { cwd: "/tmp/elsewhere" },
      { projectId: "workspace:client" },
      { projectGitUrl: "https://github.com/acme/repo.git" },
      { repository: { url: "https://github.com/acme/repo.git" } },
      { execNode: "laptop" },
      { worktreeSource: "empty" },
      { catalogId: "catalog" },
      { fork: true },
      { forkFrom: "agent:client:dashboard:parent" },
      { parentSessionKey: "agent:client:dashboard:parent" },
      { incognito: true },
    ];
    for (const request of others) {
      expect(
        shouldDefaultSessionWorktree({ ...person, cfg, request: request as never }),
        JSON.stringify(request),
      ).toBe(false);
    }
  });
});
