import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  resolveCommandProcessSignal,
  runOutsideCommandProcessScope,
} from "../../process/exec-spawn.js";
import type { WorkspaceSkillsSnapshot } from "../../skills/loading/workspace-skill-materialization.js";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "./backend.types.js";
import { hashTextSha256 } from "./hash.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import {
  PUBLISH_REMOTE_WORKSPACE,
  CLEANUP_REMOTE_WORKSPACE_STAGE,
} from "./remote-shell-bootstrap-python.js";
import {
  buildRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
  ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT,
} from "./remote-shell-command.js";
import type { RemoteShellSandboxSession } from "./remote-shell-transport.js";

type PendingExec = { session: RemoteShellSandboxSession; cleanup: () => Promise<void> };
type SkillsPublication = {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
};

type PreprovisionedRemoteWorkdir = { runtimeId: string; remoteWorkspaceDir: string };
type ResolvedRemoteRuntimePaths = {
  runtimeId: string;
  runtimeRootDir: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  remoteSkillsWorkspaceDir: string;
};
export type RemoteShellSandboxBackendOptions = {
  createSession: () => Promise<RemoteShellSandboxSession>;
  backendId?: string;
  runtimeId?: string;
  configLabel?: string;
  configLabelKind?: string;
  preprovisionedWorkdir?: PreprovisionedRemoteWorkdir;
};

export async function createRemoteShellSandboxBackend(
  params: CreateSandboxBackendParams,
  options: RemoteShellSandboxBackendOptions,
): Promise<SandboxBackendHandle & RemoteShellSandboxHandle> {
  if ((params.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("Remote shell sandbox backend does not support sandbox.docker.binds.");
  }
  const runtimePaths = options.preprovisionedWorkdir
    ? resolvePreprovisionedRuntimePaths(options.preprovisionedWorkdir)
    : resolveRemoteShellRuntimePaths(params.cfg.ssh.workspaceRoot, params.scopeKey);
  params.assertRuntimeCurrent?.();
  const skillsSnapshot =
    !options.preprovisionedWorkdir &&
    params.cfg.workspaceAccess === "rw" &&
    params.skillsWorkspaceDir
      ? params.skillsMaterialization
      : undefined;
  if (
    !options.preprovisionedWorkdir &&
    params.cfg.workspaceAccess === "rw" &&
    params.skillsWorkspaceDir &&
    !skillsSnapshot
  ) {
    throw new Error("Remote sandbox skills require a completed core materialization snapshot");
  }
  params.assertRuntimeCurrent?.();
  if (skillsSnapshot) {
    if (!/^[a-f0-9]{64}$/.test(skillsSnapshot.revision)) {
      throw new Error("Remote sandbox skills have an invalid materialization revision");
    }
    runtimePaths.remoteSkillsWorkspaceDir = path.posix.join(
      runtimePaths.remoteSkillsWorkspaceDir,
      "generations",
      skillsSnapshot.revision,
    );
  }
  return new RemoteShellSandboxBackendImpl({
    skillsSnapshot,
    createParams: params,
    preprovisionedWorkdir: options.preprovisionedWorkdir,
    backendId: options.backendId ?? params.cfg.backend,
    runtimeId: options.runtimeId,
    configLabel: options.configLabel,
    configLabelKind: options.configLabelKind,
    createSession: options.createSession,
    runtimePaths,
  }).asHandle();
}

class RemoteShellSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;
  private skillsPublication: SkillsPublication | null = null;
  private readonly pendingExecs = new WeakMap<object, PendingExec>();

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      skillsSnapshot?: WorkspaceSkillsSnapshot;
      preprovisionedWorkdir?: PreprovisionedRemoteWorkdir;
      createSession: () => Promise<RemoteShellSandboxSession>;
      backendId: string;
      runtimeId?: string;
      configLabel?: string;
      configLabelKind?: string;
      runtimePaths: ResolvedRemoteRuntimePaths;
    },
  ) {}

  asHandle(): SandboxBackendHandle & RemoteShellSandboxHandle {
    return {
      id: this.params.backendId,
      runtimeId: this.params.runtimeId ?? this.params.runtimePaths.runtimeId,
      runtimeLabel: this.params.runtimeId ?? this.params.runtimePaths.runtimeId,
      workdir: this.params.runtimePaths.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: this.params.configLabel,
      configLabelKind: this.params.configLabelKind,
      workdirValidation: "backend",
      validateWorkdir: (workdir) => this.validateWorkdir(workdir),
      workdirRoots: [
        this.params.runtimePaths.remoteWorkspaceDir,
        ...(this.params.preprovisionedWorkdir
          ? []
          : [this.params.runtimePaths.remoteAgentWorkspaceDir]),
      ],
      ...(this.params.skillsSnapshot
        ? {
            skillsWorkspace: {
              hostPath: this.params.skillsSnapshot.workspaceDir,
              containerPath: this.params.runtimePaths.remoteSkillsWorkspaceDir,
            },
          }
        : {}),
      remoteWorkspaceDir: this.params.runtimePaths.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.params.runtimePaths.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        const remoteWorkdir = workdir ?? this.params.runtimePaths.remoteWorkspaceDir;
        const remoteCommand = buildValidatedExecRemoteCommand({
          command,
          workdir: remoteWorkdir,
          env: {},
        });
        await this.ensureRuntime();
        await this.ensureRemoteSkillsWorkspace();
        const session = await this.createSession();
        try {
          this.params.createParams.assertRuntimeCurrent?.();
          const prepared = await session.prepareExec({
            remoteCommand,
            env,
            tty: usePty,
          });
          try {
            this.params.createParams.assertRuntimeCurrent?.();
          } catch (error) {
            await prepared.cleanup();
            throw error;
          }
          const finalizeToken = {};
          this.pendingExecs.set(finalizeToken, { session, cleanup: prepared.cleanup });
          return {
            argv: prepared.argv,
            env: prepared.env,
            cwd: prepared.cwd,
            stdinMode: "pipe-open",
            assertCurrent: this.params.createParams.assertRuntimeCurrent,
            finalizeToken,
          };
        } catch (error) {
          await session.dispose();
          throw error;
        }
      },
      finalizeExec: async ({ token }) => {
        if (!token || typeof token !== "object") {
          return;
        }
        const pending = this.pendingExecs.get(token);
        if (!pending) {
          return;
        }
        this.pendingExecs.delete(token);
        try {
          await pending.cleanup();
        } finally {
          await pending.session.dispose();
        }
      },
      runShellCommand: (command) => this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({
          sandbox,
          runtime: this.asHandle(),
        }),
      runRemoteShellScript: (command) => this.runRemoteShellScript(command),
    };
  }

  private async createSession(): Promise<RemoteShellSandboxSession> {
    this.params.createParams.assertRuntimeCurrent?.();
    const session = await this.params.createSession();
    try {
      this.params.createParams.assertRuntimeCurrent?.();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  private async ensureRuntime(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    // Concurrent exec/fs calls share one remote copy bootstrap; failures reset
    // the promise so the next call can retry after transient transport errors.
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureRuntimeInner(): Promise<void> {
    if (this.params.preprovisionedWorkdir) {
      // The placement lifecycle owns this exact worktree. Backend mirroring here would overwrite
      // managed files and bypass the placement's manifest/reconciliation boundary.
      return;
    }
    const session = await this.createSession();
    let stagingRoot: string | undefined;
    try {
      this.params.createParams.assertRuntimeCurrent?.();
      const exists = await session.runCommand({
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
          "openclaw-sandbox-check",
          this.params.runtimePaths.runtimeRootDir,
        ]),
      });
      if (exists.stdout.toString("utf8").trim() === "1") {
        return;
      }
      const candidate = `${this.params.runtimePaths.runtimeRootDir}.bootstrap-${randomUUID()}`;
      this.params.createParams.assertRuntimeCurrent?.();
      await session.runCommand({
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'mkdir -p -- "$1" && (umask 077; mkdir -- "$2")',
          "openclaw-sandbox-stage",
          path.posix.dirname(candidate),
          candidate,
        ]),
      });
      stagingRoot = candidate;
      this.params.createParams.assertRuntimeCurrent?.();
      await session.uploadDirectory({
        localDir: this.params.createParams.workspaceDir,
        remoteDir: path.posix.join(stagingRoot, "workspace"),
        remoteRootDir: stagingRoot,
      });
      if (
        this.params.createParams.cfg.workspaceAccess !== "none" &&
        path.resolve(this.params.createParams.agentWorkspaceDir) !==
          path.resolve(this.params.createParams.workspaceDir)
      ) {
        this.params.createParams.assertRuntimeCurrent?.();
        await session.uploadDirectory({
          localDir: this.params.createParams.agentWorkspaceDir,
          remoteDir: path.posix.join(stagingRoot, "agent"),
          remoteRootDir: stagingRoot,
        });
      }
      this.params.createParams.assertRuntimeCurrent?.();
      await session.runCommand({
        remoteCommand: buildRemoteCommand([
          "python3",
          "-c",
          PUBLISH_REMOTE_WORKSPACE,
          stagingRoot,
          this.params.runtimePaths.runtimeRootDir,
        ]),
      });
      stagingRoot = undefined;
    } finally {
      if (stagingRoot) {
        // Preserve the original failure. An unreachable orphan never becomes a
        // completed workspace, and cleanup must not guess at other publishers.
        await session
          .runCommand({
            remoteCommand: buildRemoteCommand([
              "python3",
              "-c",
              CLEANUP_REMOTE_WORKSPACE_STAGE,
              stagingRoot,
            ]),
            allowFailure: true,
          })
          .catch(() => undefined);
      }
      await session.dispose();
    }
  }

  private async validateWorkdir(workdir: string): Promise<string | null> {
    await this.ensureRuntime();
    if (isRemotePathInsideRoot(this.params.runtimePaths.remoteSkillsWorkspaceDir, workdir)) {
      await this.ensureRemoteSkillsWorkspace();
    }
    const session = await this.createSession();
    try {
      this.params.createParams.assertRuntimeCurrent?.();
      const result = await session.runCommand({
        remoteCommand: buildRemoteWorkdirValidationCommand({
          workdir,
          root: this.resolveWorkdirValidationRoot(workdir),
        }),
        allowFailure: true,
      });
      const resolvedWorkdir = result.code === 0 ? result.stdout.toString("utf8").trim() : "";
      return resolvedWorkdir || null;
    } finally {
      await session.dispose();
    }
  }

  private resolveWorkdirValidationRoot(workdir: string): string {
    const roots = [
      this.params.runtimePaths.remoteAgentWorkspaceDir,
      this.params.runtimePaths.remoteWorkspaceDir,
    ];
    return (
      roots.find((root) => isRemotePathInsideRoot(root, workdir)) ??
      this.params.runtimePaths.remoteWorkspaceDir
    );
  }

  private async ensureRemoteSkillsWorkspace(callerSignal?: AbortSignal): Promise<void> {
    if (!this.params.skillsSnapshot) {
      return;
    }
    const signal = resolveCommandProcessSignal(callerSignal);
    signal?.throwIfAborted();
    let publication = this.skillsPublication;
    if (!publication) {
      const controller = new AbortController();
      const next: SkillsPublication = {
        controller,
        waiters: 0,
        settled: false,
        promise: runOutsideCommandProcessScope(() =>
          this.publishRemoteSkillsWithOwnedSession(controller.signal),
        ),
      };
      next.promise = next.promise.then(
        () => {
          next.settled = true;
        },
        (error: unknown) => {
          next.settled = true;
          if (this.skillsPublication === next) {
            this.skillsPublication = null;
          }
          throw error;
        },
      );
      this.skillsPublication = publication = next;
    }
    publication.waiters += 1;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      publication.waiters -= 1;
      if (!publication.settled && publication.waiters === 0) {
        // Retire synchronously on abort, before an awaited session can dispatch remote work.
        if (this.skillsPublication === publication) {
          this.skillsPublication = null;
        }
        publication.controller.abort(signal?.reason);
      }
    };
    const listener = signal ? addAbortListener(signal, release) : undefined;
    try {
      await racePromiseWithAbortSignal(publication.promise, signal);
      signal?.throwIfAborted();
      this.params.createParams.assertRuntimeCurrent?.();
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      listener?.[Symbol.dispose]();
      release();
      if (publication.controller.signal.aborted) {
        // The final waiter owns stop-and-join; another caller never inherits its cancellation.
        await publication.promise.catch(() => undefined);
      }
    }
  }

  private async publishRemoteSkillsWithOwnedSession(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const session = await this.createSession();
    try {
      signal.throwIfAborted();
      await this.publishRemoteSkillsWorkspace(session, signal);
    } finally {
      await session.dispose();
    }
  }

  private async publishRemoteSkillsWorkspace(
    session: RemoteShellSandboxSession,
    signal?: AbortSignal,
  ): Promise<void> {
    const snapshot = this.params.skillsSnapshot;
    if (!snapshot) {
      return;
    }
    const destination = this.params.runtimePaths.remoteSkillsWorkspaceDir;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      this.params.createParams.assertRuntimeCurrent?.();
    };
    assertCurrent();
    const exists = await session.runCommand({
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        `${ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT}\nif [ -d "$3" ] && [ ! -L "$3" ]; then printf "1\\n"; else printf "0\\n"; fi`,
        "openclaw-skills-check",
        path.posix.dirname(destination),
        this.params.runtimePaths.runtimeRootDir,
        destination,
      ]),
      signal,
    });
    assertCurrent();
    if (exists.stdout.toString("utf8").trim() === "1") {
      return;
    }
    const staging = `${destination}.staging-${randomUUID()}`;
    try {
      await session.runCommand({
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          `${ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT}\n(umask 077; mkdir -- "$3")`,
          "openclaw-skills-stage",
          path.posix.dirname(destination),
          this.params.runtimePaths.runtimeRootDir,
          staging,
        ]),
        signal,
      });
      assertCurrent();
      await session.uploadDirectory({
        localDir: snapshot.workspaceDir,
        remoteDir: staging,
        remoteRootDir: this.params.runtimePaths.runtimeRootDir,
        signal,
      });
      assertCurrent();
      // Publish a complete generation once. Concurrent handles only discard their own loser stage.
      await session.runCommand({
        remoteCommand: buildRemoteCommand([
          "python3",
          "-c",
          PUBLISH_REMOTE_WORKSPACE,
          staging,
          destination,
        ]),
        signal,
      });
      assertCurrent();
    } finally {
      await session
        .runCommand({
          remoteCommand: buildRemoteCommand([
            "python3",
            "-c",
            CLEANUP_REMOTE_WORKSPACE_STAGE,
            staging,
          ]),
          allowFailure: true,
        })
        .catch(() => undefined);
    }
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    params.signal?.throwIfAborted();
    await this.ensureRuntime();
    params.signal?.throwIfAborted();
    await this.ensureRemoteSkillsWorkspace(params.signal);
    params.signal?.throwIfAborted();
    const session = await this.createSession();
    try {
      params.signal?.throwIfAborted();
      this.params.createParams.assertRuntimeCurrent?.();
      return await session.runCommand({
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          params.script,
          "openclaw-sandbox-fs",
          ...(params.args ?? []),
        ]),
        stdin: params.stdin,
        allowFailure: params.allowFailure,
        signal: params.signal,
      });
    } finally {
      await session.dispose();
    }
  }
}

function normalizeRemotePath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  return normalized === "/" ? normalized : normalized.replace(/\/+$/g, "");
}

function isRemotePathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedCandidate = normalizeRemotePath(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    (normalizedRoot === "/"
      ? normalizedCandidate.startsWith("/")
      : normalizedCandidate.startsWith(`${normalizedRoot}/`))
  );
}

// Preserve existing remote workspace identities across transport changes.
export function resolveRemoteShellRuntimePaths(
  workspaceRoot: string,
  scopeKey: string,
): ResolvedRemoteRuntimePaths {
  const runtimeId = buildRemoteShellRuntimeId(scopeKey);
  const runtimeRootDir = path.posix.join(workspaceRoot, runtimeId);
  return {
    runtimeId,
    runtimeRootDir,
    remoteWorkspaceDir: path.posix.join(runtimeRootDir, "workspace"),
    remoteAgentWorkspaceDir: path.posix.join(runtimeRootDir, "agent"),
    remoteSkillsWorkspaceDir: path.posix.join(
      runtimeRootDir,
      "workspace",
      ".openclaw",
      "sandbox-skills",
    ),
  };
}

function resolvePreprovisionedRuntimePaths(
  params: PreprovisionedRemoteWorkdir,
): ResolvedRemoteRuntimePaths {
  const remoteWorkspaceDir = params.remoteWorkspaceDir;
  if (
    !path.posix.isAbsolute(remoteWorkspaceDir) ||
    remoteWorkspaceDir === "/" ||
    path.posix.normalize(remoteWorkspaceDir) !== remoteWorkspaceDir ||
    remoteWorkspaceDir.endsWith("/")
  ) {
    throw new Error("Preprovisioned remote workdir must be an absolute non-root path.");
  }
  const runtimeId = params.runtimeId.trim();
  if (!runtimeId) {
    throw new Error("Preprovisioned remote runtime id must be a non-empty string.");
  }
  return {
    runtimeId,
    runtimeRootDir: remoteWorkspaceDir,
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir: remoteWorkspaceDir,
    remoteSkillsWorkspaceDir: path.posix.join(remoteWorkspaceDir, ".openclaw", "sandbox-skills"),
  };
}

function buildRemoteShellRuntimeId(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  if (/:workspace:[a-f0-9]{32}$/i.test(trimmed)) {
    return `openclaw-ssh-workspace-${hashTextSha256(trimmed).slice(0, 32)}`;
  }
  // Keep the path human-readable while hashing the original scope to avoid
  // collisions after normalization and truncation.
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-ssh-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
