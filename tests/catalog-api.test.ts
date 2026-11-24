import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import type { MediaStore } from "../lib/media-store";
import { GET as catalogGet } from "../app/api/catalog/route";
import { GET as mediaGet } from "../app/api/media/[id]/route";
import type { CatalogRow } from "../lib/catalog";

const id = "1aa4cc1c-b9f1-4a66-82f6-9fd36a994f81";
const fixture = path.resolve(process.cwd(), "data/demo/synthetic_demo.wav");

test("catalogue metadata remains available while media denies every ID without D1 or R2 reads", async () => {
  const original = await readFile(fixture);
  const storageKey = `${id}.wav`;
  // This is only a mocked eligible database row; no real music licence is asserted or published.
  const row: CatalogRow = {
    id, title: "Synthetic test tone", artist: "Synthetic test audio", album: "MIXORA development fixtures",
    release_year: null, category: "ANY", genre: "Test audio", language: "UNKNOWN", duration_ms: "5000",
    bpm: 78, musical_key: null, energy: 0.55,
    rights_holder: "Mock rights holder (unit test only)", rights_basis: "DIRECT_LICENSE",
    attribution_url: null, rights_expires_at: null, storage_key: storageKey,
    mime_type: "audio/wav", byte_size: String(original.length),
    sha256: createHash("sha256").update(original).digest("hex"),
  };
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase; mixoraMediaStore?: MediaStore };
  const oldDatabase = globals.mixoraD1Database;
  const oldStore = globals.mixoraMediaStore;
  const oldOrigin = process.env.PUBLIC_CATALOG_ORIGIN;
  let databaseReads = 0;
  let mediaReads = 0;
  process.env.PUBLIC_CATALOG_ORIGIN = "https://catalog.example.test";
  globals.mixoraMediaStore = {
    put: async () => { mediaReads++; throw new Error("Public media must not write R2"); },
    head: async () => { mediaReads++; throw new Error("Public media must not inspect R2"); },
    delete: async () => { mediaReads++; throw new Error("Public media must not delete R2"); },
    get: async () => { mediaReads++; throw new Error("Public media must not read R2"); },
  };
  let visible = true;
  globals.mixoraD1Database = { query: async (sql: string, args?: unknown[]) => {
    databaseReads++;
    assert.match(sql, /source_type IN \('PROVIDER', 'ARTIST', 'LOCAL_IMPORT'\)/);
    assert.match(sql, /development_only=0/);
    assert.match(sql, /distribution_allowed=1 AND offline_allowed=1 AND mix_allowed=1/);
    assert.match(sql, /catalog_rights_reviews/);
    return { rows: visible && (!args || args[0] === id) ? [row] : [], changes: 0 };
  }, end: async () => undefined } as CatalogDatabase;
  const assertDenied = async (trackId: string, headers?: HeadersInit) => {
    const before = databaseReads;
    const response = await mediaGet(new Request(`https://catalog.example.test/api/media/${trackId}`, { headers }),
      { params: Promise.resolve({ id: trackId }) });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "Audio unavailable");
    assert.equal(databaseReads, before, "Public media must not query D1");
    assert.equal(mediaReads, 0, "Public media must not read R2");
  };
  try {
    const catalog = await catalogGet(new Request("https://catalog.example.test/api/catalog"));
    assert.equal(catalog.status, 200);
    const data = await catalog.json();
    assert.equal(data.schemaVersion, 1);
    assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
    assert.equal(data.tracks.length, 1);
    assert.equal(data.tracks[0].audioUrl, `https://catalog.example.test/api/media/${id}`);
    assert.equal(data.tracks[0].sha256, row.sha256);
    assert.equal(data.tracks[0].category, "ANY");
    assert.equal(data.tracks[0].genre, "Test audio");
    assert.equal(data.tracks[0].bpm, 78);
    assert.equal(data.tracks[0].energy, 0.55);

    await assertDenied(id);
    await assertDenied(id, { Range: "bytes=0-99" });
    await assertDenied("00000000-0000-4000-8000-000000000000");
    await assertDenied("not-a-valid-id");
    visible = false;
    const empty = await catalogGet(new Request("https://catalog.example.test/api/catalog"));
    assert.equal(empty.status, 200);
    const emptyData = await empty.json();
    assert.equal(emptyData.schemaVersion, 1);
    assert.deepEqual(emptyData.tracks, []);
    await assertDenied(id); // Same response after this previously visible track disappears.
  } finally {
    globals.mixoraD1Database = oldDatabase;
    globals.mixoraMediaStore = oldStore;
    if (oldOrigin === undefined) delete process.env.PUBLIC_CATALOG_ORIGIN; else process.env.PUBLIC_CATALOG_ORIGIN = oldOrigin;
  }
});

test("production catalogue rejects missing or non-HTTPS public origin", async () => {
  const mutableEnvironment = process.env as Record<string, string | undefined>;
  const oldEnvironment = mutableEnvironment.NODE_ENV;
  const oldOrigin = process.env.PUBLIC_CATALOG_ORIGIN;
  try {
    mutableEnvironment.NODE_ENV = "production";
    for (const invalid of ["", "http://example.test", "https://user@example.test", "https://example.test/path"]) {
      process.env.PUBLIC_CATALOG_ORIGIN = invalid;
      const response = await catalogGet(new Request("https://example.test/api/catalog"));
      assert.equal(response.status, 503);
    }
  } finally {
    if (oldEnvironment === undefined) delete mutableEnvironment.NODE_ENV; else mutableEnvironment.NODE_ENV = oldEnvironment;
    if (oldOrigin === undefined) delete process.env.PUBLIC_CATALOG_ORIGIN; else process.env.PUBLIC_CATALOG_ORIGIN = oldOrigin;
  }
});
