import "../lib/load-env";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GET as catalogGet } from "../app/api/catalog/route";
import { db } from "../lib/db";
import { mediaStore } from "../lib/media-store";
import { importCatalog } from "./import-catalog";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Development verification cannot run in production");
  if (!process.env.CLOUDFLARE_D1_DATABASE_ID || !process.env.R2_BUCKET) {
    throw new Error("Configure Cloudflare D1 and R2 in .env.local before live verification");
  }
  const manifest = path.resolve("data/demo/manifest.json");
  const source = await readFile(path.resolve("data/demo/synthetic_demo.wav"));
  const first = await importCatalog(manifest);
  assert.equal(first.imported + first.unchanged, 1);
  const second = await importCatalog(manifest);
  assert.deepEqual(second, { imported: 0, unchanged: 1 });
  const result = await db().query<{
    id: string; storage_key: string; sha256: string; byte_size: string;
    duration_ms: string; mime_type: string; source_type: string;
    development_only: number; published: number; rights_holder: string | null;
  }>(`SELECT id, storage_key, sha256, byte_size, duration_ms, mime_type,
            source_type, development_only, published, rights_holder
      FROM catalog_tracks WHERE provider_id=$1 AND external_id=$2`,
    ["development:mixora-synthetic", "synthetic-demo-v1"]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.sha256, createHash("sha256").update(source).digest("hex"));
  assert.equal(Number(row.byte_size), source.length);
  assert.equal(Number(row.duration_ms), 5000);
  assert.equal(row.mime_type, "audio/wav");
  assert.equal(row.source_type, "DEVELOPMENT_TEST");
  assert.equal(row.development_only, 1);
  assert.equal(row.published, 0);
  assert.equal(row.rights_holder, null);
  const object = await mediaStore().get(row.storage_key);
  assert.ok(object);
  const stored = Buffer.from(await new Response(object.body).arrayBuffer());
  assert.deepEqual(stored, source);
  const denied = await db().query<{ id: string }>(
    "UPDATE catalog_tracks SET published=1 WHERE id=$1 AND development_only=0 RETURNING id", [row.id]);
  assert.equal(denied.rows.length, 0);
  const catalog = await catalogGet(new Request("http://localhost:3000/api/catalog"));
  assert.equal(catalog.status, 200);
  const body = await catalog.json();
  assert.equal(body.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  assert.ok(Array.isArray(body.tracks));
  assert.equal(body.tracks.some((track: { id: string }) => track.id === row.id), false);
  console.log("Live D1/R2 import, stored bytes, duplicate prevention, rights gate, and catalogue exclusion verified");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { if (process.env.CLOUDFLARE_D1_DATABASE_ID) db().end().catch(() => undefined); });
