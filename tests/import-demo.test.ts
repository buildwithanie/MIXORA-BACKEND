import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import { MediaObjectConflictError, type MediaStore } from "../lib/media-store";
import { importCatalog } from "../scripts/import-catalog";

test("ingests original WAV once, records metadata and checksum, and rejects invalid audio", async () => {
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase; mixoraMediaStore?: MediaStore };
  const oldDatabase = globals.mixoraD1Database;
  const oldStore = globals.mixoraMediaStore;
  const objects = new Map<string, Buffer>();
  let conflictOnPut = false;
  globals.mixoraMediaStore = {
    put: async (key, bytes) => {
      if (conflictOnPut) throw new MediaObjectConflictError();
      objects.set(key, Buffer.from(bytes));
    },
    head: async (key) => objects.has(key) ? { bytes: objects.get(key)!.length, mimeType: "audio/wav",
      sha256: createHash("sha256").update(objects.get(key)!).digest("hex") } : null,
    get: async () => null,
    delete: async (key) => { objects.delete(key); },
  };
  let saved: { id: string; storage_key: string; sha256: string; byte_size: string; import_fingerprint: string } | undefined;
  let inserted: unknown[] | undefined;
  globals.mixoraD1Database = { query: async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT id, storage_key")) return { rows: saved ? [saved] : [] };
    if (sql.startsWith("SELECT provider_id, external_id")) return { rows: saved ? [{ provider_id: "development:mixora-synthetic", external_id: "synthetic-demo-v1" }] : [] };
    if (sql.includes("INSERT INTO catalog_tracks")) {
      assert.equal(values?.length, 32);
      assert.equal(values?.[31], null, "development audio has no invented submitter");
      inserted = values;
      saved = { id: String(values![0]), storage_key: String(values![18]), sha256: String(values![21]), byte_size: String(values![20]), import_fingerprint: String(values![30]) };
      return { rows: [], changes: 1 };
    }
    throw new Error("Unexpected catalog query");
  }, end: async () => undefined } as CatalogDatabase;
  try {
    const manifest = path.resolve(process.cwd(), "data/demo/manifest.json");
    const first = await importCatalog(manifest);
    assert.deepEqual(first, { imported: 1, unchanged: 0 });
    assert.equal(objects.size, 1);
    const source = await readFile(path.resolve(process.cwd(), "data/demo/synthetic_demo.wav"));
    const stored = objects.get(saved!.storage_key)!;
    assert.deepEqual(stored, source);
    assert.equal(inserted?.[1], "development:mixora-synthetic");
    assert.equal(inserted?.[9], 5000);
    assert.equal(inserted?.[19], "audio/wav");
    assert.equal(inserted?.[20], source.length);
    assert.equal(inserted?.[21], createHash("sha256").update(source).digest("hex"));
    assert.equal(inserted?.[26], "DEVELOPMENT_TEST");
    assert.equal(inserted?.[28], true);
    assert.equal(inserted?.[29], false);
    const second = await importCatalog(manifest);
    assert.deepEqual(second, { imported: 0, unchanged: 1 });
    assert.equal(objects.size, 1);
    const beforeConflict = { ...saved! };
    const conflictDir = await mkdtemp(path.join(tmpdir(), "mixora-conflict-"));
    try {
      const changedAudio = Buffer.from(source);
      changedAudio[44] ^= 1;
      await writeFile(path.join(conflictDir, "synthetic_demo.wav"), changedAudio);
      const conflictManifest = JSON.parse(await readFile(manifest, "utf8"));
      conflictManifest.tracks[0].title = "Conflict candidate";
      await writeFile(path.join(conflictDir, "manifest.json"), JSON.stringify(conflictManifest));
      conflictOnPut = true;
      await assert.rejects(importCatalog(path.join(conflictDir, "manifest.json")), MediaObjectConflictError);
      assert.deepEqual(saved, beforeConflict, "a storage conflict must not update the D1 track");
      assert.equal(objects.size, 1, "a storage conflict must not delete the existing audio");
    } finally {
      conflictOnPut = false;
      await rm(conflictDir, { recursive: true, force: true });
    }
    const changedDir = await mkdtemp(path.join(tmpdir(), "mixora-changed-"));
    try {
      await copyFile(path.resolve(process.cwd(), "data/demo/synthetic_demo.wav"), path.join(changedDir, "synthetic_demo.wav"));
      const changedManifest = JSON.parse(await readFile(manifest, "utf8"));
      changedManifest.tracks[0].title = "Synthetic test tone revised";
      await writeFile(path.join(changedDir, "manifest.json"), JSON.stringify(changedManifest));
      const changed = await importCatalog(path.join(changedDir, "manifest.json"));
      assert.deepEqual(changed, { imported: 1, unchanged: 0 });
      assert.equal(inserted?.[3], "Synthetic test tone revised");
      assert.equal(inserted?.[29], false);
      assert.equal(objects.size, 1);
      changedManifest.tracks[0].externalId = "different-id-same-audio";
      await writeFile(path.join(changedDir, "manifest.json"), JSON.stringify(changedManifest));
      await assert.rejects(importCatalog(path.join(changedDir, "manifest.json")), /checksum already imported/);
    } finally { await rm(changedDir, { recursive: true, force: true }); }
    const badDir = await mkdtemp(path.join(tmpdir(), "mixora-invalid-"));
    try {
      await writeFile(path.join(badDir, "bad.wav"), Buffer.alloc(100));
      const testManifest = JSON.parse(await readFile(manifest, "utf8"));
      testManifest.tracks[0].audioFile = "bad.wav";
      await writeFile(path.join(badDir, "manifest.json"), JSON.stringify(testManifest));
      await assert.rejects(importCatalog(path.join(badDir, "manifest.json")), /Invalid WAV header/);
    } finally { await rm(badDir, { recursive: true, force: true }); }
  } finally {
    globals.mixoraD1Database = oldDatabase;
    globals.mixoraMediaStore = oldStore;
  }
});
