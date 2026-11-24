import "../lib/load-env";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { importCatalog, validate } from "./import-catalog";
import { db } from "../lib/db";
import { mediaStore } from "../lib/media-store";
import { revokeReview } from "../lib/approvals";

type FeedTrack = Parameters<typeof validate>[0] & {
  audioUrl: string;
  audioSha256: string;
  audioBytes: number;
  mimeType: string;
};

const extensions: Record<string, string> = {
  "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg",
  "audio/flac": ".flac", "audio/wav": ".wav",
};

export function providerAudioHeaders(feedUrl: string, audioUrl: string, token?: string): Record<string, string> {
  return token && new URL(audioUrl).origin === new URL(feedUrl).origin
    ? { Authorization: `Bearer ${token}` } : {};
}

export async function syncProvider() {
  const feedUrl = process.env.PROVIDER_FEED_URL;
  if (!feedUrl || !feedUrl.startsWith("https://")) throw new Error("Set an HTTPS PROVIDER_FEED_URL");
  const response = await fetch(feedUrl, {
    headers: process.env.PROVIDER_FEED_TOKEN ? { Authorization: `Bearer ${process.env.PROVIDER_FEED_TOKEN}` } : {},
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Provider feed returned ${response.status}`);
  const feed = await response.json() as { providerId: string; tracks: FeedTrack[] };
  if (!feed.providerId?.trim() || !Array.isArray(feed.tracks) || feed.tracks.length > 5_000) throw new Error("Invalid provider feed");
  const stagingRoot = path.resolve("./data/staging");
  await mkdir(stagingRoot, { recursive: true });
  const staging = path.join(stagingRoot, randomUUID());
  await mkdir(staging);
  try {
    const tracks = [];
    for (const entry of feed.tracks) {
      validate(entry);
      const audioUrl = new URL(entry.audioUrl);
      if (audioUrl.protocol !== "https:") throw new Error(`${entry.externalId}: HTTPS audio required`);
      if (!/^[a-f0-9]{64}$/i.test(entry.audioSha256)) throw new Error(`${entry.externalId}: checksum required`);
      if (!Number.isInteger(entry.audioBytes) || entry.audioBytes < 1 || entry.audioBytes > 25 * 1024 * 1024) throw new Error(`${entry.externalId}: invalid size`);
      const extension = extensions[entry.mimeType];
      if (!extension) throw new Error(`${entry.externalId}: unsupported audio format`);
      const audio = await fetch(audioUrl, {
        headers: providerAudioHeaders(feedUrl, audioUrl.href, process.env.PROVIDER_FEED_TOKEN),
        redirect: "error",
      });
      if (!audio.ok || audio.headers.get("content-type")?.split(";")[0] !== entry.mimeType) throw new Error(`${entry.externalId}: audio unavailable`);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!audio.body) throw new Error(`${entry.externalId}: empty audio response`);
      const reader = audio.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 25 * 1024 * 1024) throw new Error(`${entry.externalId}: audio too large`);
        chunks.push(value);
      }
      const content = Buffer.concat(chunks);
      const hash = createHash("sha256").update(content).digest("hex");
      if (bytes !== entry.audioBytes || hash !== entry.audioSha256.toLowerCase()) throw new Error(`${entry.externalId}: checksum mismatch`);
      const fileName = `${randomUUID()}${extension}`;
      await writeFile(path.join(staging, fileName), content);
      tracks.push({ ...entry, audioFile: fileName });
    }
    const manifestPath = path.join(staging, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ providerId: feed.providerId, sourceType: "PROVIDER", sourceFeedUrl: feedUrl, tracks }));
    await importCatalog(manifestPath, "system:provider-sync");
    const prior = await db().query<{ external_id: string; storage_key: string }>(
      "SELECT external_id, storage_key FROM catalog_tracks WHERE provider_id=$1 AND published=1",
      [feed.providerId],
    );
    const currentIds = new Set(tracks.map((track) => track.externalId));
    for (const row of prior.rows) {
      if (currentIds.has(row.external_id)) continue;
      if (!await revokeReview(feed.providerId, row.external_id, "system:provider-sync",
        "Provider feed no longer lists this track")) throw new Error("Provider withdrawal could not be audited");
      const removed = await db().query<{ storage_key: string }>(
        "UPDATE catalog_tracks SET published=0, updated_at=CURRENT_TIMESTAMP WHERE provider_id=$1 AND external_id=$2 AND published=1 RETURNING storage_key",
        [feed.providerId, row.external_id],
      );
      if (removed.rows[0]) await mediaStore().delete(removed.rows[0].storage_key).catch(() => undefined);
    }
  } finally {
    if (staging.startsWith(stagingRoot + path.sep)) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/sync-provider.ts")) {
  syncProvider()
    .then(() => db().end())
    .catch((error) => { console.error(error); process.exitCode = 1; db().end().catch(() => undefined); });
}
