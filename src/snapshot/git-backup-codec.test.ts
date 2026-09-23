import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";

it("preserves NUL-bearing TEXT, storage classes, and source key order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-backup-text-"));
  const sourcePath = path.join(root, "source.sqlite");
  const outputPath = path.join(root, "dump");
  const targetPath = path.join(root, "restored.sqlite");
  const keys = ["\0leading", "\nline", " space", "shared\0left", "shared\0right", "雪🦀\0尾"];
  const values = ["text\0suffix", "", null, 9_007_199_254_740_993n, Buffer.from([0, 255]), 1.25];
  const byteQuery =
    'SELECT hex("key") AS key, typeof(value) AS type, hex(value) AS bytes FROM text_values ORDER BY "key"';
  try {
    const source = openOpenClawStateDatabase({ path: sourcePath });
    source.db.exec('CREATE TABLE text_values ("key" TEXT PRIMARY KEY, value ANY) STRICT');
    const insert = source.db.prepare('INSERT INTO text_values ("key", value) VALUES (?, ?)');
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      insert.run(keys[index]!, values[index]!);
    }
    const expectedBytes = source.db.prepare(byteQuery).all();
    closeOpenClawStateDatabaseForTest();

    await dumpGitBackupDatabase({
      snapshotPath: sourcePath,
      outputPath,
      identity: { role: "global" },
    });
    const content = await fs.readFile(path.join(outputPath, "tables/text_values.jsonl"), "utf8");
    expect(
      content
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { key: keys[0], value: "text\0suffix" },
      { key: keys[1], value: "" },
      { key: keys[2], value: null },
      { key: keys[3], value: { $int: "9007199254740993" } },
      { key: keys[4], value: { $hex: "00ff" } },
      { key: keys[5], value: 1.25 },
    ]);
    const restored = await restoreGitBackupDirectory({
      sourcePath: outputPath,
      targetPath,
      expectedIdentity: { role: "global" },
    });
    expect(restored.tables.every((table) => table.ok)).toBe(true);
    const database = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(database.prepare(byteQuery).all()).toEqual(expectedBytes);
    } finally {
      database.close();
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("splits an oversized table at row boundaries and restores it from every part", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-backup-parts-"));
  const sourcePath = path.join(root, "source.sqlite");
  const outputPath = path.join(root, "dump");
  const targetPath = path.join(root, "restored.sqlite");
  try {
    const source = openOpenClawStateDatabase({ path: sourcePath });
    source.db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = source.db.prepare("INSERT INTO sample (id, value) VALUES (?, ?)");
    for (let id = 1; id <= 8; id += 1) {
      insert.run(id, `${id}:${"x".repeat(20_000)}`);
    }
    closeOpenClawStateDatabaseForTest();

    const manifest = await dumpGitBackupDatabase({
      snapshotPath: sourcePath,
      outputPath,
      identity: { role: "global" },
      tablePartMaxBytes: 64 * 1024,
    });
    expect(manifest.tables.sample).toMatchObject({ rows: 8, parts: 3 });
    const tableFiles = (await fs.readdir(path.join(outputPath, "tables")))
      .filter((name) => name.startsWith("sample."))
      .toSorted();
    expect(tableFiles).toEqual([
      "sample.jsonl",
      "sample.part-00001.jsonl",
      "sample.part-00002.jsonl",
    ]);
    for (const name of tableFiles) {
      const stat = await fs.stat(path.join(outputPath, "tables", name));
      expect(stat.size).toBeLessThanOrEqual(64 * 1024);
    }

    const restored = await restoreGitBackupDirectory({
      sourcePath: outputPath,
      targetPath,
      expectedIdentity: { role: "global" },
    });
    expect(restored.tables.find((table) => table.table === "sample")).toMatchObject({
      rows: 8,
      ok: true,
    });
    const database = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT count(*) AS rows FROM sample").get()).toEqual({ rows: 8 });
    } finally {
      database.close();
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
});
