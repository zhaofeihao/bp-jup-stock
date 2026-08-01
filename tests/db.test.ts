import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Recorder } from "../src/db.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Recorder migrations", () => {
  it("为旧 opportunities 表补充阶段、提醒模式和可执行性字段", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jup-db-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "old.sqlite");
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE opportunities (
        id INTEGER PRIMARY KEY,
        asset TEXT NOT NULL,
        buy_quote_id INTEGER NOT NULL,
        sell_quote_id INTEGER NOT NULL,
        eligible INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    legacy.close();

    const recorder = new Recorder(file);
    try {
      const columns = recorder.sqlite
        .prepare("PRAGMA table_info(opportunities)")
        .all() as Array<{ name: string }>;
      const names = columns.map((column) => column.name);
      expect(names).toContain("stage");
      expect(names).toContain("alert_mode");
      expect(names).toContain("execution_verified");
    } finally {
      recorder.close();
    }
  });
});
