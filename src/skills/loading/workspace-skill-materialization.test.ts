import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withSkillsWorkspaceLock } from "./workspace-skill-materialization.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("rejects a symlinked generation parent even when its completed snapshot already exists", async () => {
  const root = await fs.realpath(dirs.make("skills-snapshot-parent-"));
  const target = path.join(root, "target");
  const outside = path.join(root, "outside");
  const revision = "a".repeat(64);
  const snapshot = path.join(outside, revision);
  for (const workspace of [target, snapshot]) {
    await fs.mkdir(path.join(workspace, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "skills/.openclaw-sync.json"),
      JSON.stringify({ revision }),
    );
  }
  await fs.symlink(outside, path.join(target, ".openclaw-generations"), "dir");
  await expect(withSkillsWorkspaceLock(target, (capture) => capture())).rejects.toThrow(
    "snapshot parent must be a real directory",
  );
});

it("never reuses a persisted generation after the materialization owner restarts with repeated counters", async () => {
  const root = await fs.realpath(dirs.make("skills-owner-restart-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const skill = path.join(source, "skills", "demo");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: demo\ndescription: Synthetic skill.\n---\nRun scripts/demo.sh.\n",
  );
  await fs.writeFile(path.join(skill, "scripts/demo.sh"), "before");
  // A restart discards in-memory ownership. A repeated clock/counter must not name old bytes.
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const loadOwner = async () => {
    vi.resetModules();
    return {
      sync: await import("./workspace-skill-sync.runtime.js"),
    };
  };
  const options = {
    sourceWorkspaceDir: source,
    targetWorkspaceDir: target,
    bundledSkillsDir: path.join(root, "bundled"),
    managedSkillsDir: path.join(root, "managed"),
  };
  const first = await loadOwner();
  const old = (await first.sync.syncWorkspaceSkillsSnapshot(options)).snapshot;
  expect((await first.sync.syncWorkspaceSkillsSnapshot(options)).snapshot).toEqual(old);
  await fs.writeFile(path.join(skill, "scripts/demo.sh"), "after");
  const restarted = await loadOwner();
  const current = (await restarted.sync.syncWorkspaceSkillsSnapshot(options)).snapshot;
  expect(current.revision).not.toBe(old.revision);
  expect(
    await fs.readFile(path.join(old.workspaceDir, "skills/demo/scripts/demo.sh"), "utf8"),
  ).toBe("before");
  expect(
    await fs.readFile(path.join(current.workspaceDir, "skills/demo/scripts/demo.sh"), "utf8"),
  ).toBe("after");
});
