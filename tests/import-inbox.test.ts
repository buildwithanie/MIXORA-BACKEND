import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import type { MediaStore } from "../lib/media-store";
import { GET as catalogGet } from "../app/api/catalog/route";
import { inspectAudioFile } from "../lib/audio-file";
import { importInbox } from "../scripts/import-inbox";

test("imports a WAV inbox file, records sidecar metadata, skips duplicates, and leaves catalogue empty", async () => {
  const inbox = await mkdtemp(path.join(tmpdir(), "mixora-inbox-"));
  const fixture = path.resolve("data/demo/synthetic_demo.wav");
  await copyFile(fixture, path.join(inbox, "sample.wav"));
  await writeFile(path.join(inbox, "sample.wav.json"), JSON.stringify({
    title: "Original test recording", artist: "Synthetic test audio", album: "Test album",
    genre: "Instrumental", category: "ANY", language: "UNKNOWN", year: 2026,
    bpm: 110, musicalKey: "A minor", energy: 0.4,
  }));
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase; mixoraMediaStore?: MediaStore };
  const oldDatabase = globals.mixoraD1Database;
  const oldStore = globals.mixoraMediaStore;
  const objects = new Map<string, Buffer>();
  globals.mixoraMediaStore = {
    put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); },
    head: async (key) => objects.has(key) ? { bytes: objects.get(key)!.length, mimeType: "audio/wav",
      sha256: createHash("sha256").update(objects.get(key)!).digest("hex") } : null,
    get: async () => null,
    delete: async (key) => { objects.delete(key); },
  };
  const rows = new Map<string, unknown[]>();
  globals.mixoraD1Database = { query: async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT id, storage_key")) {
      const row = rows.get(String(values?.[1]));
      return { rows: row ? [{ id: row[0], storage_key: row[18], sha256: row[21], byte_size: row[20], import_fingerprint: row[30] }] : [], changes: 0 };
    }
    if (sql.startsWith("SELECT provider_id, external_id")) {
      return { rows: [...rows.entries()].filter(([, row]) => row[21] === values?.[1])
        .map(([external_id]) => ({ provider_id: "local:imports", external_id })), changes: 0 };
    }
    if (sql.includes("INSERT INTO catalog_tracks")) {
      rows.set(String(values?.[2]), values!);
      return { rows: [], changes: 1 };
    }
    if (sql.includes("FROM catalog_tracks") && sql.includes("WHERE published")) {
      assert.match(sql, /distribution_allowed=1 AND offline_allowed=1 AND mix_allowed=1/);
      return { rows: [], changes: 0 };
    }
    throw new Error("Unexpected query");
  }, end: async () => undefined } as CatalogDatabase;
  try {
    assert.deepEqual(await importInbox(inbox), { imported: 1, unchanged: 0 });
    assert.equal(rows.size, 1);
    const row = rows.get("sample.wav")!;
    const source = await readFile(fixture);
    assert.equal(row[3], "Original test recording");
    assert.equal(row[4], "Synthetic test audio");
    assert.equal(row[5], "Test album");
    assert.equal(row[6], 2026);
    assert.equal(row[9], 5000);
    assert.equal(row[19], "audio/wav");
    assert.equal(row[20], source.length);
    assert.equal(row[21], createHash("sha256").update(source).digest("hex"));
    assert.equal(row[23], "A minor");
    assert.equal(row[26], "LOCAL_IMPORT");
    assert.equal(row[14], false);
    assert.equal(row[15], false);
    assert.equal(row[16], false);
    assert.equal(row[29], false);
    assert.deepEqual(objects.get(String(row[18])), source);
    assert.deepEqual(await importInbox(inbox), { imported: 0, unchanged: 1 });
    await copyFile(fixture, path.join(inbox, "same-audio.wav"));
    assert.deepEqual(await importInbox(inbox), { imported: 0, unchanged: 2 });
    assert.equal(rows.size, 1);
    assert.equal(objects.size, 1);
    const api = await catalogGet(new Request("http://localhost:3000/api/catalog"));
    assert.equal(api.status, 200);
    const body = await api.json();
    assert.equal(body.schemaVersion, 1);
    assert.deepEqual(body.tracks, []);
  } finally {
    globals.mixoraD1Database = oldDatabase;
    globals.mixoraMediaStore = oldStore;
    await rm(inbox, { recursive: true, force: true });
  }
});

test("rejects an MP3 file without MPEG audio frames", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mixora-bad-mp3-"));
  try {
    const file = path.join(root, "broken.mp3");
    await writeFile(file, Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "binary"), Buffer.alloc(100)]));
    await assert.rejects(inspectAudioFile(file), /no valid audio frame/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reads common ID3 metadata from an MP3 header fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mixora-id3-"));
  try {
    const textFrame = (id: string, value: string) => {
      const payload = Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]);
      const header = Buffer.alloc(10);
      header.write(id, 0, "ascii");
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const frames = Buffer.concat([
      textFrame("TIT2", "Sample title"), textFrame("TPE1", "Sample artist"),
      textFrame("TALB", "Sample album"), textFrame("TCON", "Instrumental"),
      textFrame("TYER", "2026"), textFrame("TLEN", "5000"),
    ]);
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frames.length]);
    const frame = Buffer.alloc(417);
    frame.set([0xff, 0xfb, 0x90, 0x64], 0);
    const file = path.join(root, "tags.mp3");
    await writeFile(file, Buffer.concat([header, frames, frame]));
    const audio = await inspectAudioFile(file);
    assert.equal(audio.mimeType, "audio/mpeg");
    assert.equal(audio.durationMs, 5000);
    assert.deepEqual(audio.tags, {
      title: "Sample title", artist: "Sample artist", album: "Sample album",
      genre: "Instrumental", year: 2026,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
