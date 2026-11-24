import "../lib/load-env";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { db } from "../lib/db";

async function main() {
  const sql = await readFile(path.join(process.cwd(), "schema.sql"), "utf8");
  await db().query(sql);
  await db().query(`CREATE TABLE IF NOT EXISTS catalog_schema_migrations (
    version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await db().query("INSERT OR IGNORE INTO catalog_schema_migrations (version) VALUES ('0001_catalog')");
  const directory = path.join(process.cwd(), "migrations");
  for (const file of (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    const version = file.slice(0, -4);
    const applied = await db().query<{ version: string }>(
      "SELECT version FROM catalog_schema_migrations WHERE version=$1", [version]);
    if (applied.rows.length) continue;
    await db().query(await readFile(path.join(directory, file), "utf8"));
    await db().query("INSERT OR IGNORE INTO catalog_schema_migrations (version) VALUES ($1)", [version]);
    console.log(`Applied ${version}`);
  }
  const result = await db().query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_tracks'",
  );
  if (result.rows[0]?.name !== "catalog_tracks") throw new Error("D1 schema verification failed: catalog_tracks is missing");
  console.log("MIXORA catalog schema is ready");
  await db().end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
