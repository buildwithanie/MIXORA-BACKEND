import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import { publishedTracks } from "../lib/catalog";

test("catalogue read retries one transient connection timeout", async () => {
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };
  const original = globals.mixoraD1Database;
  let calls = 0;
  globals.mixoraD1Database = { query: async () => {
    calls++;
    if (calls === 1) throw new Error("Cloudflare D1 unavailable (503)");
    return { rows: [], changes: 0 };
  }, end: async () => undefined } as CatalogDatabase;
  try {
    assert.deepEqual(await publishedTracks(), []);
    assert.equal(calls, 2);
  } finally {
    globals.mixoraD1Database = original;
  }
});
