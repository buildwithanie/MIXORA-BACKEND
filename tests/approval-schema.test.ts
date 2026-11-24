import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { publishedTracks } from "../lib/catalog";
import type { CatalogDatabase } from "../lib/db";

test("publication requires a verified partner and current rights review, and revocation blocks reuse", async () => {
  const database = new DatabaseSync(":memory:");
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };
  const previous = globals.mixoraD1Database;
  globals.mixoraD1Database = { query: async (sql: string, values: unknown[] = []) => ({
    rows: database.prepare(sql.replace(/\$\d+/g, "?")).all(...values as (string | number | null)[]), changes: 0,
  }), end: async () => undefined } as CatalogDatabase;
  try {
    database.exec(await readFile(path.resolve("schema.sql"), "utf8"));
    database.exec(await readFile(path.resolve("migrations/0002_partner_review.sql"), "utf8"));
    database.exec(await readFile(path.resolve("migrations/0003_staff_roles.sql"), "utf8"));
    assert.equal(database.prepare("SELECT count(*) AS count FROM catalog_staff_roles").get()?.count, 0);
    // Fictional metadata exists only inside this in-memory test database.
    const id = "33333333-3333-4333-8333-333333333333";
    const fingerprint = "f".repeat(64);
    const audioHash = "a".repeat(64);
    database.prepare(`INSERT INTO catalog_tracks
      (id, provider_id, external_id, title, artist, category, language, duration_ms,
       storage_key, mime_type, byte_size, sha256, source_type, development_only,
       rights_holder, rights_basis, rights_evidence_ref, distribution_allowed,
       offline_allowed, mix_allowed, import_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, "artist:test", "demo", "Unit-test title", "Unit-test artist", "GOSPEL", "SWAHILI", 5000,
      `${id}.wav`, "audio/wav", 100, audioHash, "ARTIST", 0,
      "Unit-test holder", "DIRECT_LICENSE", "test-evidence-ref", 1, 1, 1, fingerprint,
    );
    const publish = database.prepare("UPDATE catalog_tracks SET published=1 WHERE id=?");
    assert.throws(() => publish.run(id), /review approval required/);
    database.prepare("INSERT INTO catalog_partners (partner_id, kind, display_name) VALUES (?, ?, ?)")
      .run("artist:test", "ARTIST", "Unit-test partner");
    assert.throws(() => publish.run(id), /review approval required/);
    database.prepare(`UPDATE catalog_partners SET status='VERIFIED', agreement_ref='test-agreement',
      agreement_sha256=?, verified_by='unit-test-a', verified_at=CURRENT_TIMESTAMP WHERE partner_id='artist:test'`)
      .run("b".repeat(64));
    assert.throws(() => publish.run(id), /review approval required/);
    database.prepare(`INSERT INTO catalog_rights_reviews
      (track_id, decision, reviewer_id, evidence_sha256, import_fingerprint, audio_sha256, rights_evidence_ref)
      VALUES (?, 'APPROVED', 'unit-test-b', ?, ?, ?, 'test-evidence-ref')`)
      .run(id, "c".repeat(64), fingerprint, audioHash);
    assert.equal(publish.run(id).changes, 1);
    // Legacy publication predates protected agreement storage.
    database.prepare("UPDATE catalog_tracks SET published=0 WHERE id=?").run(id);
    database.prepare(`INSERT INTO catalog_rights_reviews
      (track_id, decision, reviewer_id, import_fingerprint, audio_sha256, rights_evidence_ref)
      VALUES (?, 'REVOKED', 'unit-test-b', ?, ?, 'test-evidence-ref')`)
      .run(id, fingerprint, audioHash);
    assert.throws(() => publish.run(id), /review approval required/);

    database.exec(await readFile(path.resolve("migrations/0004_review_audit.sql"), "utf8"));
    database.exec(await readFile(path.resolve("migrations/0005_protected_agreements.sql"), "utf8"));
    assert.equal((await publishedTracks()).length, 0, "legacy approval without a protected agreement is not public");
    assert.equal(database.prepare("SELECT count(*) AS count FROM catalog_rights_reviews").get()?.count, 2,
      "Stage 2 migration preserves pre-existing review history");
  } finally { globals.mixoraD1Database = previous; database.close(); }
});

