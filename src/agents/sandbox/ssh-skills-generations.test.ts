// Exercise the registered SSH backend with its real shell/tar transport on local test roots.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { syncWorkspaceSkillsSnapshot } from "../../skills/loading/workspace-skill-sync.runtime.js";
import {
  getSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
} from "../../skills/runtime/refresh-state.js";
import { resolveSandboxSkillRuntimeInputs } from "../embedded-agent-runner/sandbox-skills.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { getSandboxBackendFactory, getSandboxBackendManager } from "./backend.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import * as ssh from "./ssh.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "pins concurrent readers to complete skill generations and only transfers changed resources",
  async () => {
    const root = await fs.realpath(dirs.make("ssh-skills-generations-"));
    const source = path.join(root, "source");
    const materialized = path.join(root, "materialized");
    const skill = path.join(source, "skills", "demo");
    await fs.mkdir(path.join(skill, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: demo\ndescription: Synthetic demo skill.\n---\nRead assets/theme.txt.\n",
    );
    await fs.writeFile(path.join(skill, "assets", "theme.txt"), "before");
    const command = path.join(root, "ssh-local");
    await fs.writeFile(
      command,
      '#!/bin/sh\nfor arg do remote_command="$arg"; done\nexec /bin/sh -c "$remote_command"\n',
      { mode: 0o700 },
    );
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            scope: "agent",
            workspaceAccess: "rw",
            ssh: { target: "fixture@localhost", command, workspaceRoot: path.join(root, "remote") },
          },
        },
      },
    };
    const cfg = resolveSandboxConfigForAgent(config);
    const sync = () =>
      syncWorkspaceSkillsSnapshot({
        sourceWorkspaceDir: source,
        targetWorkspaceDir: materialized,
        bundledSkillsDir: path.join(root, "bundled"),
        managedSkillsDir: path.join(root, "managed"),
      });
    let prepared = await sync();
    const factory = getSandboxBackendFactory("ssh");
    if (!factory) {
      throw new Error("SSH backend is not registered");
    }
    const initial = prepared;
    const create = (selection = prepared) =>
      factory({
        cfg,
        scopeKey: "agent:demo",
        sessionKey: "agent:demo:main",
        workspaceDir: source,
        agentWorkspaceDir: source,
        skillsWorkspaceDir: materialized,
        skillsMaterialization: selection.snapshot,
      });
    const [first, second] = await Promise.all([create(), create()]);
    await fs.mkdir(first.workdir, { recursive: true }); // Adopt an already-running canonical workspace.
    await fs.writeFile(path.join(first.workdir, "project.txt"), "remote edits");
    const projection = (backend: SandboxBackendHandle) => {
      // The old public path lets this regression reach the shared-directory race before the fix.
      return (
        backend.skillsWorkspace ?? {
          hostPath: materialized,
          containerPath: path.posix.join(backend.workdir, ".openclaw/sandbox-skills"),
        }
      );
    };
    const read = (backend: SandboxBackendHandle) =>
      backend.runShellCommand({
        script: 'cat "$1"',
        args: [path.posix.join(projection(backend).containerPath, "skills/demo/assets/theme.txt")],
      });
    const uploads = createDeferred();
    let release = createDeferred();
    const originalUpload = ssh.uploadDirectoryToSshTarget;
    const upload = vi
      .spyOn(ssh, "uploadDirectoryToSshTarget")
      .mockImplementation(async (params) => {
        if (upload.mock.calls.length === 2) {
          uploads.resolve();
        }
        await release.promise;
        return await originalUpload(params);
      });
    const pending = [read(first), read(second)];
    try {
      await uploads.promise;
      expect(upload.mock.calls[0]![0].remoteDir).not.toBe(upload.mock.calls[1]![0].remoteDir);
      release.resolve();
      for (const result of await Promise.all(pending)) {
        expect(result.stdout.toString()).toBe("before");
      }
      expect(projection(first)).toEqual(projection(second));
      const generations = path.posix.dirname(projection(first).containerPath);
      expect(await fs.readdir(generations)).toEqual([
        path.posix.basename(projection(first).containerPath),
      ]);
      await read(first);
      await read(await create());
      expect(upload).toHaveBeenCalledTimes(2);
      const version = getSkillsSnapshotVersion(source);
      await fs.writeFile(path.join(skill, "assets/theme.txt"), "after");
      markSkillsSupportingFilesChanged({ workspaceDir: source });
      expect(getSkillsSnapshotVersion(source)).toBe(version);
      prepared = await sync();
      // A second sync may win before a previously prepared context creates its backend.
      const retained = await create(initial);
      expect(projection(retained)).toEqual(projection(first));
      expect((await read(retained)).stdout.toString()).toBe("before");
      expect(upload).toHaveBeenCalledTimes(2);
      const changed = await create();
      expect(projection(changed).containerPath).not.toBe(projection(first).containerPath);
      expect(
        await fs.readFile(
          path.join(projection(first).hostPath, "skills/demo/assets/theme.txt"),
          "utf8",
        ),
      ).toBe("before");
      release = createDeferred();
      const entered = createDeferred();
      upload.mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        await originalUpload(params);
      });
      const changedRead = read(changed);
      try {
        await entered.promise;
        expect((await read(first)).stdout.toString()).toBe("before");
        release.resolve();
        expect((await changedRead).stdout.toString()).toBe("after");
      } finally {
        release.resolve();
        await changedRead;
      }
      expect(upload).toHaveBeenCalledTimes(3);
      expect((await read(first)).stdout.toString()).toBe("before");
      expect(await fs.readFile(path.join(first.workdir, "project.txt"), "utf8")).toBe(
        "remote edits",
      );
      const snapshot = projection(changed);
      const sandbox = {
        workspaceDir: source,
        agentWorkspaceDir: source,
        skillsWorkspaceDir: snapshot.hostPath,
        workspaceAccess: "rw" as const,
        containerName: changed.runtimeId,
        containerWorkdir: changed.workdir,
        docker: cfg.docker,
      };
      const bridge = changed.createFsBridge?.({ sandbox });
      if (!bridge) {
        throw new Error("SSH filesystem bridge is missing");
      }
      const localSkill = path.join(snapshot.hostPath, "skills/demo/SKILL.md");
      const remoteSkill = path.posix.join(snapshot.containerPath, "skills/demo/SKILL.md");
      expect(bridge.resolvePath({ filePath: localSkill }).containerPath).toBe(remoteSkill);
      await expect(bridge.writeFile({ filePath: remoteSkill, data: "overwrite" })).rejects.toThrow(
        "read-only",
      );
      await expect(
        bridge.remove({ filePath: projection(first).containerPath, recursive: true }),
      ).rejects.toThrow("read-only");
      const prompt = resolveSandboxSkillRuntimeInputs({
        sandbox: {
          ...sandbox,
          enabled: true,
          skillsContainerWorkdir: snapshot.containerPath,
          skillUsagePaths: [
            {
              readPath: localSkill,
              skillFile: path.join(skill, "SKILL.md"),
              skillName: "demo",
              skillSource: "workspace",
            },
          ],
        },
        skillsAnchorWorkspace: source,
      });
      expect(prompt.skillsPromptWorkspaceDir).toBe(snapshot.containerPath);
      expect(prompt.skillUsagePaths?.[0]?.readPath).toBe(remoteSkill);
      const manager = getSandboxBackendManager("ssh");
      if (!manager) {
        throw new Error("SSH runtime manager is missing");
      }
      await manager.removeRuntime({
        config,
        entry: {
          containerName: first.runtimeId,
          backendId: "ssh",
          sessionKey: "agent:demo",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "fixture@localhost",
        },
      });
      await expect(fs.stat(generations)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  },
);
