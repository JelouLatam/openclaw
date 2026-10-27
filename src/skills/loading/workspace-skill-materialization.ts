// Materialized skill copies and their immutable snapshots share one publication owner.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../../infra/errno.js";
import { tryReadJson } from "../../infra/json-files.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveUserPath } from "../../utils.js";

const skillsSyncQueue = new KeyedAsyncQueue();

export async function withSkillsWorkspaceLock<T>(
  workspaceDir: string,
  operation: (capture: () => Promise<WorkspaceSkillsSnapshot>) => Promise<T>,
): Promise<T> {
  const source = resolveUserPath(workspaceDir);
  return await skillsSyncQueue.enqueue(`syncSkills:${source}`, async () => {
    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new Error("Skill materialization transaction is closed");
      }
    };
    try {
      return await operation(() => captureWorkspaceSkillsSnapshot(source, assertCurrent));
    } finally {
      active = false;
    }
  });
}
export const SYNCED_SKILLS_MANIFEST_NAME = ".openclaw-sync.json";

export type WorkspaceSkillsSnapshot = { workspaceDir: string; revision: string };

async function readMaterializationRevision(workspaceDir: string): Promise<string> {
  const manifest = await tryReadJson<unknown>(
    path.join(workspaceDir, "skills", SYNCED_SKILLS_MANIFEST_NAME),
  );
  if (
    !isRecord(manifest) ||
    typeof manifest.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.revision)
  ) {
    throw new Error("Sandbox skills have no completed materialization revision");
  }
  return manifest.revision;
}

/** Capture only completed owner-published bytes, never a directory being resynchronized. */
async function captureWorkspaceSkillsSnapshot(
  workspaceDir: string,
  assertCurrent?: () => void,
): Promise<WorkspaceSkillsSnapshot> {
  const source = resolveUserPath(workspaceDir);
  assertCurrent?.();
  const revision = await readMaterializationRevision(source);
  assertCurrent?.();
  const parent = path.join(source, ".openclaw-generations");
  const destination = path.join(parent, revision);
  const existingParent = await fs.lstat(parent).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (existingParent && !existingParent.isDirectory()) {
    throw new Error("Sandbox skills snapshot parent must be a real directory");
  }
  const existing = await fs.lstat(destination).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || (await readMaterializationRevision(destination)) !== revision) {
      throw new Error("Sandbox skills snapshot does not match its materialization");
    }
    assertCurrent?.();
    return { workspaceDir: destination, revision };
  }
  assertCurrent?.();
  await fs.mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  });
  if (!(await fs.lstat(parent)).isDirectory()) {
    throw new Error("Sandbox skills snapshot parent must be a real directory");
  }
  const staging = path.join(parent, `.staging-${randomUUID()}`);
  assertCurrent?.();
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    assertCurrent?.();
    await fs.cp(path.join(source, "skills"), path.join(staging, "skills"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    try {
      assertCurrent?.();
      await fs.rename(staging, destination);
    } catch (error) {
      if (!hasErrnoCode(error, "EEXIST") && !hasErrnoCode(error, "ENOTEMPTY")) {
        throw error;
      }
      const winner = await fs.lstat(destination);
      if (!winner.isDirectory() || (await readMaterializationRevision(destination)) !== revision) {
        throw error;
      }
    }
    assertCurrent?.();
    return { workspaceDir: destination, revision };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
