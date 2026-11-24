import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BoundD1Database } from "../lib/db";
import { BoundMediaStore, MediaObjectConflictError } from "../lib/media-store";
import type { MixoraWorkerEnv } from "../lib/worker-bindings";

test("bound D1 adapter keeps parameterized SQL and returns rows", async () => {
  let sql = "";
  let params: string[] = [];
  const binding = { prepare(input: string) {
    sql = input;
    return { bind(...values: string[]) {
      params = values;
      return { all: async <T>() => ({ success: true,
        results: [{ id: "sample" }] as unknown as T[], meta: { changes: 0 } }) };
    } };
  } };
  const result = await new BoundD1Database(binding).query<{ id: string }>(
    "SELECT id FROM catalog_tracks WHERE id=$1 AND published=$2", ["sample", true]);
  assert.deepEqual(result.rows, [{ id: "sample" }]);
  assert.equal(sql, "SELECT id FROM catalog_tracks WHERE id=? AND published=?");
  assert.deepEqual(params, ["sample", "1"]);
});

test("bound R2 adapter atomically refuses overwrites and preserves audio metadata", async () => {
  const objects = new Map<string, { bytes: Buffer; mime: string; sha: string }>();
  const binding = {
    async put(key: string, body: Uint8Array, options: {
      onlyIf: Headers; httpMetadata: { contentType: string }; customMetadata: { sha256: string };
    }) {
      assert.equal(options.onlyIf.get("If-None-Match"), "*");
      if (objects.has(key)) return null;
      objects.set(key, { bytes: Buffer.from(body), mime: options.httpMetadata.contentType,
        sha: options.customMetadata.sha256 });
      return { size: body.byteLength };
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.length, httpMetadata: { contentType: object.mime },
        customMetadata: { sha256: object.sha } } : null;
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.length, httpMetadata: { contentType: object.mime },
        customMetadata: { sha256: object.sha }, body: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(object.bytes); controller.close(); },
        }) } : null;
    },
    async delete(key: string) { objects.delete(key); },
  } satisfies MixoraWorkerEnv["MIXORA_AUDIO"];
  const store = new BoundMediaStore(binding);
  const key = `${randomUUID()}.wav`;
  await store.put(key, Buffer.from("synthetic"), "audio/wav", "abc");
  await assert.rejects(store.put(key, Buffer.from("different"), "audio/wav", "def"), MediaObjectConflictError);
  assert.deepEqual(objects.get(key)?.bytes, Buffer.from("synthetic"));
  assert.deepEqual(await store.head(key), { bytes: 9, mimeType: "audio/wav", sha256: "abc" });
  const downloaded = await store.get(key);
  assert.deepEqual(Buffer.from(await new Response(downloaded?.body).arrayBuffer()), Buffer.from("synthetic"));
  await store.delete(key);
  assert.equal(await store.head(key), null);
});
