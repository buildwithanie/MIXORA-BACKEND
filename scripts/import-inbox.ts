import "../lib/load-env";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { inspectAudioFile } from "../lib/audio-file";
import { db } from "../lib/db";
import { Entry, importManifest } from "./import-catalog";

export async function importInbox(root = path.resolve("data/imports")) {
  await mkdir(root, { recursive: true });
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((item) => item.isFile() && /\.(mp3|wav)$/i.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) {
    console.log(`No MP3 or WAV files found in ${root}`);
    return { imported: 0, unchanged: 0 };
  }
  const tracks: Entry[] = [];
  for (const file of files) {
    const audio = await inspectAudioFile(path.join(root, file.name));
    let sidecar: Partial<Entry> = {};
    try {
      const parsed = JSON.parse(await readFile(path.join(root, `${file.name}.json`), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Metadata sidecar must be a JSON object");
      sidecar = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    tracks.push({
      title: sidecar.title ?? audio.tags.title ?? path.parse(file.name).name,
      artist: sidecar.artist ?? audio.tags.artist ?? "Unknown artist",
      album: sidecar.album ?? audio.tags.album,
      genre: sidecar.genre ?? audio.tags.genre,
      year: sidecar.year ?? audio.tags.year,
      durationMs: sidecar.durationMs ?? audio.durationMs ?? undefined,
      category: sidecar.category ?? "ANY",
      language: sidecar.language ?? "UNKNOWN",
      bpm: sidecar.bpm,
      musicalKey: sidecar.musicalKey,
      energy: sidecar.energy,
      rightsHolder: sidecar.rightsHolder,
      rightsBasis: sidecar.rightsBasis,
      rightsEvidenceRef: sidecar.rightsEvidenceRef,
      attributionUrl: sidecar.attributionUrl,
      distributionAllowed: sidecar.distributionAllowed,
      offlineAllowed: sidecar.offlineAllowed,
      mixAllowed: sidecar.mixAllowed,
      rightsExpiresAt: sidecar.rightsExpiresAt,
      externalId: file.name.toLowerCase(),
      audioFile: file.name,
    });
  }
  return importManifest({ providerId: "local:imports", sourceType: "LOCAL_IMPORT", tracks }, root);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/import-inbox.ts")) {
  importInbox()
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => { if (process.env.CLOUDFLARE_D1_DATABASE_ID) db().end().catch(() => undefined); });
}
