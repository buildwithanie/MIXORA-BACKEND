import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { CloudflareD1Database } from "../lib/db";

test("D1 schema accepts development audio and blocks publication without rights", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(await readFile(path.resolve("schema.sql"), "utf8"));
    sqlite.prepare(`INSERT INTO catalog_tracks
      (id, provider_id, external_id, title, artist, category, language, duration_ms,
       storage_key, mime_type, byte_size, sha256, source_type, development_only)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "11111111-1111-4111-8111-111111111111", "development:fixture", "tone", "Test tone",
      "Synthetic test audio", "ANY", "UNKNOWN", 5000, "11111111-1111-4111-8111-111111111111.wav",
      "audio/wav", 100, "a".repeat(64), "DEVELOPMENT_TEST", 1,
    );
    assert.throws(() => sqlite.prepare("UPDATE catalog_tracks SET published=1 WHERE external_id='tone'").run(), /CHECK constraint failed/);
    assert.equal((sqlite.prepare("SELECT published FROM catalog_tracks WHERE external_id='tone'").get() as { published: number }).published, 0);
    assert.throws(() => sqlite.prepare(`INSERT INTO catalog_tracks
      (id, provider_id, external_id, title, artist, category, language, storage_key,
       mime_type, byte_size, sha256, source_type, development_only)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "22222222-2222-4222-8222-222222222222", "development:fixture", "tone2", "Another tone",
      "Synthetic test audio", "ANY", "UNKNOWN", "22222222-2222-4222-8222-222222222222.wav",
      "audio/wav", 100, "a".repeat(64), "DEVELOPMENT_TEST", 1,
    ), /UNIQUE constraint failed/);
  } finally { sqlite.close(); }
});

test("D1 client binds parameters and reads Cloudflare's response shape", async () => {
  let requestBody: { sql: string; params: string[] } | undefined;
  const request = async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ success: true, result: [{ success: true, results: [{ id: "abc" }], meta: { changes: 0 } }] });
  };
  const client = new CloudflareD1Database("account", "database", "test-token", request as typeof fetch);
  assert.deepEqual((await client.query<{ id: string }>("SELECT id FROM catalog_tracks WHERE id=$1 AND published=$2", ["abc", true])).rows,
    [{ id: "abc" }]);
  assert.deepEqual(requestBody, { sql: "SELECT id FROM catalog_tracks WHERE id=? AND published=?", params: ["abc", "1"] });
});
