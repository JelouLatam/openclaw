import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { agentIdentityGetHandler } from "./agent-identity.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function readName(cfg: OpenClawConfig): Promise<unknown> {
  const respond = vi.fn();
  await agentIdentityGetHandler({
    params: { agentId: "main" },
    respond,
    context: { getRuntimeConfig: () => cfg } as never,
    req: { type: "req", id: "memo", method: "agent.identity.get" },
    client: null,
    isWebchatConnect: () => false,
  });
  const [ok, payload] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  return (payload as { name?: string } | undefined)?.name;
}

it("reuses an identity response briefly and drops it on a config change", async () => {
  await withTestDir({ prefix: "openclaw-identity-memo-" }, async (workspace) => {
    const identityFile = path.join(workspace, "IDENTITY.md");
    await fs.writeFile(identityFile, "- **Name:** First\n", "utf8");
    const cfg: OpenClawConfig = { agents: { list: [{ id: "main", workspace }] } };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    expect(await readName(cfg)).toBe("First");
    await fs.writeFile(identityFile, "- **Name:** Second, longer\n", "utf8");
    expect(await readName(cfg)).toBe("First");

    expect(await readName({ ...cfg })).toBe("Second, longer");
    clock.mockReturnValue(1_002_001);
    expect(await readName(cfg)).toBe("Second, longer");
  });
});
