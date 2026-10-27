import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../../process/exec-spawn.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { createRemoteShellSandboxBackend } from "./remote-shell-backend.js";
import {
  createRemoteShellSandboxSession,
  type RemoteShellSandboxSession,
} from "./remote-shell-transport.js";

type RemoteShellUploadParams = Parameters<RemoteShellSandboxSession["uploadDirectory"]>[0];
type ColdOperation = "shell" | "exec" | "workdir";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createCommandCancellationFixture() {
  const workspaceDir = tempDirs.make("remote-shell-cancellation-");
  await fs.mkdir(path.join(workspaceDir, "skills"));
  await fs.writeFile(
    path.join(workspaceDir, "skills", ".openclaw-sync.json"),
    JSON.stringify({ revision: "a".repeat(64) }),
  );
  const session = {
    runCommand: vi.fn<RemoteShellSandboxSession["runCommand"]>(
      async ({ remoteCommand, signal }) => {
        // The real command transport inherits this process scope in addition to its explicit signal.
        resolveCommandProcessSignal(signal)?.throwIfAborted();
        return {
          stdout: Buffer.from(remoteCommand.includes("openclaw-skills-check") ? "0\n" : "1\n"),
          stderr: Buffer.alloc(0),
          code: 0,
        };
      },
    ),
    uploadDirectory: vi.fn<RemoteShellSandboxSession["uploadDirectory"]>(async () => {}),
    prepareExec: vi.fn<RemoteShellSandboxSession["prepareExec"]>(async () => {
      throw new Error("unexpected exec preparation");
    }),
    dispose: vi.fn(async () => {}),
  } satisfies RemoteShellSandboxSession;
  const createSession = vi.fn(async () => session);
  const backend = await createRemoteShellSandboxBackend(
    {
      cfg: resolveSandboxConfigForAgent({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "ssh",
              workspaceAccess: "rw",
              ssh: { target: "unused", workspaceRoot: path.join(workspaceDir, "remote") },
            },
          },
        },
      }),
      scopeKey: "command-cancellation",
      sessionKey: "test",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      skillsWorkspaceDir: workspaceDir,
      skillsMaterialization: { workspaceDir, revision: "a".repeat(64) },
    },
    { createSession },
  );
  // Bootstrap is complete, but publication of the new skills generation is still cold.
  await backend.validateWorkdir?.(backend.workdir);
  session.runCommand.mockClear();
  session.uploadDirectory.mockClear();
  session.dispose.mockClear();
  createSession.mockClear();
  const coldOperation = (entry: ColdOperation, signal?: AbortSignal): Promise<unknown> => {
    if (entry === "exec") {
      return backend.buildExecSpec({ command: "first sentinel", env: {}, usePty: false });
    }
    if (entry === "workdir") {
      if (!backend.validateWorkdir || !backend.skillsWorkspace) {
        throw new Error("Skill workdir validation is missing");
      }
      return backend.validateWorkdir(backend.skillsWorkspace.containerPath);
    }
    return backend.runShellCommand({ script: "first sentinel", signal });
  };
  return { backend, session, createSession, coldOperation };
}

describe("remote shell command cancellation", () => {
  it.each([
    ["shell", "check"],
    ["shell", "upload"],
    ["exec", "upload"],
    ["workdir", "upload"],
  ] as const)(
    "cancels cold %s during skills %s and joins publication and session disposal",
    async (entry, phase) => {
      const { session, coldOperation } = await createCommandCancellationFixture();
      const controller = new AbortController();
      const entered = createDeferred();
      const release = createDeferred();
      const disposing = createDeferred();
      const releaseDisposal = createDeferred();
      const cancelled = createDeferred();
      let cancellationObserved = false;
      let completed = false;
      const hold = async (signal?: AbortSignal) => {
        signal?.addEventListener(
          "abort",
          () => {
            cancellationObserved = true;
            cancelled.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await release.promise;
        signal?.throwIfAborted();
      };
      if (phase === "check") {
        session.runCommand.mockImplementationOnce(async ({ signal }) => {
          await hold(signal);
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
        });
      } else {
        session.uploadDirectory.mockImplementationOnce(({ signal }) => hold(signal));
      }
      session.dispose.mockImplementationOnce(async () => {
        disposing.resolve();
        await releaseDisposal.promise;
      });
      const command =
        entry === "shell"
          ? coldOperation(entry, controller.signal)
          : withCommandProcessScope(() => coldOperation(entry), controller.signal);
      const result = command.then(
        () => {
          completed = true;
          return undefined;
        },
        (error: unknown) => {
          completed = true;
          return error;
        },
      );
      try {
        await entered.promise;
        controller.abort(new Error("interrupt deadline"));
        await cancelled.promise;
        expect(cancellationObserved).toBe(true);
        expect(session.dispose).not.toHaveBeenCalled();
        expect(completed).toBe(false);
        release.resolve();
        await disposing.promise;
        expect(completed).toBe(false);
        releaseDisposal.resolve();
        expect(await result).toEqual(expect.objectContaining({ message: "interrupt deadline" }));
        expect(
          session.runCommand.mock.calls.some(([params]) =>
            params.remoteCommand.includes("openclaw-sandbox-fs"),
          ),
        ).toBe(false);
        expect(
          session.runCommand.mock.calls.some(([params]) =>
            params.remoteCommand.includes("rename_no_replace"),
          ),
        ).toBe(false);
        expect(session.uploadDirectory).toHaveBeenCalledTimes(phase === "upload" ? 1 : 0);
        expect(session.dispose).toHaveBeenCalledOnce();
        expect(session.prepareExec).not.toHaveBeenCalled();
        expect(
          session.runCommand.mock.calls.some(([params]) =>
            params.remoteCommand.includes("openclaw-validate-workdir"),
          ),
        ).toBe(false);
      } finally {
        release.resolve();
        releaseDisposal.resolve();
        await result;
      }
    },
  );

  it.each([
    ["first", "shell"],
    ["second", "shell"],
    ["first", "exec"],
    ["first", "workdir"],
  ] as const)(
    "lets the %s cold %s waiter cancel without stopping the live sibling",
    async (cancelledCaller, entry) => {
      const { backend, session, coldOperation } = await createCommandCancellationFixture();
      const firstController = cancelledCaller === "first" ? new AbortController() : undefined;
      const secondController = new AbortController();
      const entered = createDeferred();
      const release = createDeferred();
      const joined = createDeferred();
      let publicationSignal: AbortSignal | undefined;
      session.uploadDirectory.mockImplementationOnce(async ({ signal }) => {
        publicationSignal = signal;
        entered.resolve();
        await release.promise;
        signal?.throwIfAborted();
      });
      const addListener = secondController.signal.addEventListener.bind(secondController.signal);
      const listener = vi
        .spyOn(secondController.signal, "addEventListener")
        .mockImplementation((...args) => {
          addListener(...args);
          if (args[0] === "abort") {
            joined.resolve();
          }
        });
      const observe = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
      const first = observe(
        withCommandProcessScope(
          () => coldOperation(entry, entry === "shell" ? firstController?.signal : undefined),
          firstController?.signal,
        ),
      );
      await entered.promise;
      const second = observe(
        backend.runShellCommand({ script: "second sentinel", signal: secondController.signal }),
      );
      try {
        await joined.promise;
        const reason = new Error("cancel only my command");
        (firstController ?? secondController).abort(reason);
        expect(await (cancelledCaller === "first" ? first : second)).toBe(reason);
        expect(publicationSignal?.aborted).toBe(false);
        expect(session.dispose).not.toHaveBeenCalled();
        release.resolve();
        expect(await (cancelledCaller === "first" ? second : first)).toMatchObject({ code: 0 });
        expect(session.uploadDirectory).toHaveBeenCalledOnce();
        expect(session.dispose).toHaveBeenCalledTimes(2); // Publication, then the live command.
        expect(session.prepareExec).not.toHaveBeenCalled();
        const commands = session.runCommand.mock.calls.filter(([params]) =>
          params.remoteCommand.includes("openclaw-sandbox-fs"),
        );
        expect(commands).toHaveLength(1);
        expect(commands[0]?.[0].remoteCommand).toContain(
          cancelledCaller === "first" ? "second sentinel" : "first sentinel",
        );
      } finally {
        release.resolve();
        listener.mockRestore();
        await Promise.all([first, second]);
      }
    },
  );

  it("aborts and joins the owned publication when every cold waiter cancels", async () => {
    const { backend, session } = await createCommandCancellationFixture();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const entered = createDeferred();
    const release = createDeferred();
    const joined = createDeferred();
    const stopped = createDeferred();
    const disposing = createDeferred();
    const releaseDisposal = createDeferred();
    session.uploadDirectory.mockImplementationOnce(async ({ signal }) => {
      signal?.addEventListener("abort", () => stopped.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      signal?.throwIfAborted();
    });
    session.dispose.mockImplementationOnce(async () => {
      disposing.resolve();
      await releaseDisposal.promise;
    });
    const addListener = secondController.signal.addEventListener.bind(secondController.signal);
    const listener = vi
      .spyOn(secondController.signal, "addEventListener")
      .mockImplementation((...args) => {
        addListener(...args);
        if (args[0] === "abort") {
          joined.resolve();
        }
      });
    const first = backend
      .runShellCommand({ script: "first sentinel", signal: firstController.signal })
      .catch((error: unknown) => error);
    await entered.promise;
    let finished = false;
    const second = backend
      .runShellCommand({ script: "second sentinel", signal: secondController.signal })
      .then(
        () => {
          finished = true;
        },
        (error: unknown) => {
          finished = true;
          return error;
        },
      );
    try {
      await joined.promise;
      firstController.abort(new Error("first stopped"));
      expect(await first).toMatchObject({ message: "first stopped" });
      secondController.abort(new Error("second stopped"));
      await stopped.promise;
      expect(finished).toBe(false);
      expect(session.dispose).not.toHaveBeenCalled();
      release.resolve();
      await disposing.promise;
      expect(finished).toBe(false);
      releaseDisposal.resolve();
      expect(await second).toMatchObject({ message: "second stopped" });
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(
        session.runCommand.mock.calls.some(
          ([params]) =>
            params.remoteCommand.includes("rename_no_replace") ||
            params.remoteCommand.includes("openclaw-sandbox-fs"),
        ),
      ).toBe(false);
      expect(
        session.runCommand.mock.calls.some(([params]) =>
          params.remoteCommand.includes("shutil.rmtree"),
        ),
      ).toBe(true);
    } finally {
      release.resolve();
      releaseDisposal.resolve();
      listener.mockRestore();
      await Promise.all([first, second]);
    }
  });

  it("disposes a session acquired after cancellation without starting remote work", async () => {
    const { backend, session, createSession } = await createCommandCancellationFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    createSession.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return session;
    });
    const command = backend.runShellCommand({
      script: "touch sentinel",
      signal: controller.signal,
    });
    const result = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      controller.abort(new Error("interrupt deadline"));
      release.resolve();
      expect(await result).toEqual(expect.objectContaining({ message: "interrupt deadline" }));
      expect(session.runCommand).not.toHaveBeenCalled();
      expect(session.uploadDirectory).not.toHaveBeenCalled();
      expect(session.dispose).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await result;
    }
  });
});

async function createFixture() {
  const root = await fs.realpath(tempDirs.make("remote-shell-bootstrap-"));
  const remoteRoot = path.join(root, "remote");
  const partialDir = path.join(root, "partial");
  await fs.mkdir(partialDir);
  await fs.writeFile(path.join(partialDir, "partial.txt"), "incomplete transfer");
  const cfg = resolveSandboxConfigForAgent(
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            scope: "session",
            workspaceAccess: "rw",
            ssh: { target: "unused", workspaceRoot: remoteRoot },
          },
        },
      },
    },
    "test",
  );
  const createBackend = async (
    label: string,
    upload?: (
      params: RemoteShellUploadParams,
      run: (params: RemoteShellUploadParams) => Promise<void>,
    ) => Promise<void>,
  ) => {
    const workspaceDir = path.join(root, label, "workspace");
    const agentWorkspaceDir = path.join(root, label, "agent");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(agentWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "full.txt"), `${label}-primary`);
    await fs.writeFile(path.join(agentWorkspaceDir, "full.txt"), `${label}-agent`);
    return createRemoteShellSandboxBackend(
      {
        cfg,
        scopeKey: "shared-scope",
        sessionKey: "test",
        workspaceDir,
        agentWorkspaceDir,
      },
      {
        createSession: async () => {
          const session = createRemoteShellSandboxSession({
            buildCommand: ({ remoteCommand }) => ({
              argv: ["/bin/sh", "-c", remoteCommand],
              env: process.env,
            }),
          });
          return {
            ...session,
            uploadDirectory: (params) =>
              upload
                ? upload(params, (input) => session.uploadDirectory(input))
                : session.uploadDirectory(params),
          };
        },
      },
    );
  };
  const protectedDir = path.join(root, "protected");
  const restrictiveDirectories: string[] = [];
  const makeStageReadOnly = async (directory: string) => {
    const child = path.join(directory, "readonly");
    const nested = path.join(child, "nested");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "payload"), "readonly payload");
    await fs.mkdir(protectedDir, { recursive: true });
    await fs.writeFile(path.join(protectedDir, "untouched"), "outside stage");
    await fs.chmod(protectedDir, 0o555);
    await fs.symlink(protectedDir, path.join(child, "outside"));
    restrictiveDirectories.push(directory, child, nested);
    await fs.chmod(nested, 0o400);
    await fs.chmod(child, 0o400);
    await fs.chmod(directory, 0o400);
  };
  const restorePermissions = async () => {
    for (const directory of [...restrictiveDirectories, protectedDir]) {
      await fs.chmod(directory, 0o700).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      });
    }
  };
  const assertProtectedUnchanged = async () => {
    expect((await fs.stat(protectedDir)).mode & 0o777).toBe(0o555);
    expect(await fs.readFile(path.join(protectedDir, "untouched"), "utf8")).toBe("outside stage");
  };
  return {
    remoteRoot,
    partialDir,
    createBackend,
    makeStageReadOnly,
    restorePermissions,
    assertProtectedUnchanged,
  };
}

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "remote workspace initialization",
  () => {
    it.each([
      { interrupted: "workspace", readOnly: false },
      { interrupted: "agent", readOnly: true },
    ])(
      "retries incomplete $interrupted uploads without publishing a partial workspace (readonly=$readOnly)",
      async ({ interrupted, readOnly }) => {
        const fixture = await createFixture();
        let failed = false;
        const backend = await fixture.createBackend("source", async (params, upload) => {
          if (!failed && path.basename(params.remoteDir) === interrupted) {
            failed = true;
            await upload({ ...params, localDir: fixture.partialDir });
            if (readOnly) {
              await fixture.makeStageReadOnly(params.remoteDir);
            }
            throw new Error("interrupted initial upload");
          }
          await upload(params);
        });
        try {
          const root = path.dirname(backend.workdir);
          await expect(backend.runShellCommand({ script: "true" })).rejects.toThrow(
            "interrupted initial upload",
          );
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([]);
          if (readOnly) {
            await fixture.assertProtectedUnchanged();
          }
          await backend.runShellCommand({ script: "true" });
          expect(await fs.readFile(path.join(backend.workdir, "full.txt"), "utf8")).toBe(
            "source-primary",
          );
          expect(await fs.readFile(path.join(root, "agent", "full.txt"), "utf8")).toBe(
            "source-agent",
          );
          expect(await fs.readdir(backend.workdir)).toEqual(["full.txt"]);
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([path.basename(root)]);
        } finally {
          await fixture.restorePermissions();
        }
      },
    );

    it.each([
      { winner: "emptied", readOnlyLoser: false },
      { winner: "edited", readOnlyLoser: true },
    ])(
      "keeps a concurrently published $winner workspace (readonly loser=$readOnlyLoser)",
      async ({ winner, readOnlyLoser }) => {
        const fixture = await createFixture();
        const firstReady = createDeferred();
        const secondReady = createDeferred();
        const releaseFirst = createDeferred();
        const releaseSecond = createDeferred();
        const first = await fixture.createBackend("first", async (params, upload) => {
          await upload(params);
          if (path.basename(params.remoteDir) === "agent") {
            firstReady.resolve();
            await releaseFirst.promise;
          }
        });
        const second = await fixture.createBackend("second", async (params, upload) => {
          await upload(params);
          if (path.basename(params.remoteDir) === "agent") {
            if (readOnlyLoser) {
              await fixture.makeStageReadOnly(params.remoteDir);
            }
            secondReady.resolve();
            await releaseSecond.promise;
          }
        });
        const one = first.runShellCommand({ script: "true" });
        const two = second.runShellCommand({ script: "true" });
        try {
          await Promise.all([firstReady.promise, secondReady.promise]);
          releaseFirst.resolve();
          await one;
          const runtimeRoot = path.dirname(first.workdir);
          if (winner === "emptied") {
            await fs.rm(first.workdir, { recursive: true });
            await fs.rm(path.join(runtimeRoot, "agent"), { recursive: true });
          } else {
            await fs.writeFile(path.join(first.workdir, "full.txt"), "remote user edit");
          }
          releaseSecond.resolve();
          await two;
          if (winner === "emptied") {
            expect(await fs.readdir(runtimeRoot)).toEqual([]);
          } else {
            expect(await fs.readFile(path.join(first.workdir, "full.txt"), "utf8")).toBe(
              "remote user edit",
            );
            expect(await fs.readFile(path.join(runtimeRoot, "agent", "full.txt"), "utf8")).toBe(
              "first-agent",
            );
          }
          if (readOnlyLoser) {
            await fixture.assertProtectedUnchanged();
          }
          expect(await fs.readdir(fixture.remoteRoot)).toEqual([
            path.basename(path.dirname(first.workdir)),
          ]);
        } finally {
          releaseFirst.resolve();
          releaseSecond.resolve();
          await Promise.allSettled([one, two]);
          await fixture.restorePermissions();
        }
      },
    );

    it("adopts existing unmarked remote workspaces without reseeding them", async () => {
      const fixture = await createFixture();
      const backend = await fixture.createBackend("source");
      await fs.mkdir(backend.workdir, { recursive: true });
      await fs.writeFile(path.join(backend.workdir, "full.txt"), "existing remote edit");
      await backend.runShellCommand({ script: "true" });
      expect(await fs.readFile(path.join(backend.workdir, "full.txt"), "utf8")).toBe(
        "existing remote edit",
      );
      await expect(
        fs.stat(path.join(path.dirname(backend.workdir), "agent")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
