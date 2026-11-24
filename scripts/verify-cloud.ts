import "../lib/load-env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectAudioFile } from "../lib/audio-file";
import { db } from "../lib/db";
import { mediaStore } from "../lib/media-store";

export async function verifyCloud(): Promise<void> {
  const schema = await readFile(path.resolve("schema.sql"), "utf8");
  const expectedColumns = [...schema.matchAll(/^    ([a-z0-9_]+) (TEXT|INTEGER|REAL)\b/gm)]
    .map((match) => [match[1], match[2]] as const);
  const expectedIndexes = [...schema.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z0-9_]+)/g)]
    .map((match) => match[1]);
  assert.ok(expectedColumns.length > 0 && expectedIndexes.length > 0, "Local D1 schema has no columns or indexes");

  const objects = await db().query<{ name: string; type: string }>(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%'",
  );
  const remote = new Map(objects.rows.map((row) => [row.name, row.type]));
  assert.equal(remote.get("catalog_tracks"), "table", "Remote D1 catalog_tracks table is missing");
  for (const name of expectedIndexes) assert.equal(remote.get(name), "index", `Remote D1 index ${name} is missing`);
  for (const name of ["catalog_schema_migrations", "catalog_partners", "catalog_rights_reviews", "catalog_staff_roles", "catalog_review_events", "catalog_agreements", "catalog_agreement_events"]) {
    assert.equal(remote.get(name), "table", `Remote D1 table ${name} is missing`);
  }
  assert.equal(remote.get("catalog_reviews_track_idx"), "index", "Remote D1 review index is missing");
  assert.equal(remote.get("catalog_staff_roles_active_idx"), "index", "Remote D1 staff role index is missing");
  for (const name of ["catalog_review_events_entity_idx", "catalog_review_events_previous_idx",
    "catalog_reviews_audit_event_idx", "catalog_agreements_partner_idx", "catalog_agreement_events_agreement_idx", "catalog_agreement_events_previous_idx"]) {
    assert.equal(remote.get(name), "index", `Remote D1 audit index ${name} is missing`);
  }
  for (const name of ["catalog_review_events_insert_guard", "catalog_review_events_partner_projection",
    "catalog_review_events_track_projection", "catalog_reviews_new_insert_guard",
    "catalog_reviews_immutable_update", "catalog_reviews_immutable_delete",
    "catalog_review_events_immutable_update", "catalog_review_events_immutable_delete",
    "catalog_agreement_events_insert_guard", "catalog_agreement_events_decision_projection",
    "catalog_agreement_events_immutable_update", "catalog_agreement_events_immutable_delete",
    "catalog_agreements_immutable_delete", "catalog_agreements_metadata_guard",
    "catalog_agreements_status_guard", "catalog_agreement_revoke_partner"]) {
    assert.equal(remote.get(name), "trigger", `Remote D1 audit trigger ${name} is missing`);
  }
  for (const name of ["catalog_publish_insert_guard", "catalog_publish_update_guard", "catalog_publish_agreement_guard"]) {
    assert.equal(remote.get(name), "trigger", `Remote D1 publication guard ${name} is missing`);
  }
  const migrations = await db().query<{ version: string }>(
    "SELECT version FROM catalog_schema_migrations WHERE version IN ('0002_partner_review', '0003_staff_roles', '0004_review_audit', '0005_protected_agreements')");
  const versions = new Set(migrations.rows.map((row) => row.version));
  assert.ok(versions.has("0002_partner_review"), "Partner review migration is not recorded");
  assert.ok(versions.has("0003_staff_roles"), "Staff roles migration is not recorded");
  assert.ok(versions.has("0004_review_audit"), "Review audit migration is not recorded");
  assert.ok(versions.has("0005_protected_agreements"), "Protected agreement migration is not recorded");

  const columns = await db().query<{ name: string; type: string }>("PRAGMA table_info(catalog_tracks)");
  const remoteColumns = new Map(columns.rows.map((row) => [row.name, row.type.toUpperCase()]));
  for (const [name, type] of expectedColumns) {
    assert.equal(remoteColumns.get(name), type, `Remote D1 column ${name} is missing or has the wrong type`);
  }
  console.log(`D1 verified: catalog_tracks (${expectedColumns.length} columns), partner, review and staff role tables, migrations 0002-0005, publication and audit guards.`);

  const audio = await inspectAudioFile(path.resolve("data/demo/synthetic_demo.wav"));
  assert.equal(audio.mimeType, "audio/wav", "R2 verification requires the original synthetic WAV fixture");
  const key = `${randomUUID()}.wav`;
  const store = mediaStore();
  assert.equal(await store.head(key), null, "Temporary R2 key unexpectedly exists");
  let uploaded = false;
  try {
    await store.put(key, audio.bytes, audio.mimeType, audio.sha256);
    uploaded = true;
    const metadata = await store.head(key);
    assert.equal(metadata?.bytes, audio.byteSize, "R2 object size mismatch");
    assert.equal(metadata?.mimeType, audio.mimeType, "R2 MIME type mismatch");
    assert.equal(metadata?.sha256, audio.sha256, "R2 object checksum metadata mismatch");
    const object = await store.get(key);
    assert.ok(object, "R2 uploaded object cannot be retrieved");
    const downloaded = Buffer.from(await new Response(object.body).arrayBuffer());
    assert.deepEqual(downloaded, audio.bytes, "R2 downloaded audio differs from uploaded audio");
    console.log(`R2 verified: private bucket upload, metadata, and byte-for-byte download (${audio.byteSize} bytes).`);
  } finally {
    if (uploaded) {
      await store.delete(key);
      assert.equal(await store.head(key), null, "Temporary R2 verification object was not removed");
    }
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/verify-cloud.ts")) {
  verifyCloud().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Cloud verification failed");
    process.exitCode = 1;
  });
}

