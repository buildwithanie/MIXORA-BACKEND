import "../lib/load-env";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectAudioFile } from "../lib/audio-file";
import { db } from "../lib/db";
import { mediaStore } from "../lib/media-store";
import { requireStaffRole, staffFromEnvironment } from "../lib/staff-auth";
import type { StaffPrincipal } from "../lib/staff-auth";

export type Entry = {
  externalId: string;
  audioFile: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  category: "ANY" | "GOSPEL" | "BONGO" | "SECULAR" | "WORSHIP";
  genre?: string;
  language: "UNKNOWN" | "SWAHILI" | "ENGLISH" | "KIKUYU";
  durationMs?: number;
  bpm?: number;
  musicalKey?: string;
  energy?: number;
  rightsHolder?: string;
  rightsBasis?: "CC_BY" | "CC0" | "PUBLIC_DOMAIN" | "DIRECT_LICENSE" | "LABEL_CONTRACT";
  rightsEvidenceRef?: string;
  attributionUrl?: string;
  distributionAllowed?: boolean;
  offlineAllowed?: boolean;
  mixAllowed?: boolean;
  rightsExpiresAt?: string;
};

export type Manifest = {
  providerId: string;
  sourceType?: "PROVIDER" | "ARTIST" | "LOCAL_IMPORT" | "DEVELOPMENT_TEST";
  sourceFeedUrl?: string;
  tracks: Entry[];
};

export function validate(entry: Entry, sourceType: Manifest["sourceType"] = "PROVIDER") {
  if (![entry.externalId, entry.title, entry.artist].every((v) => typeof v === "string" && v.trim())) {
    throw new Error("Track requires ID, title, and artist");
  }
  if (sourceType === "DEVELOPMENT_TEST") {
    if (entry.rightsHolder || entry.rightsBasis || entry.rightsEvidenceRef || entry.distributionAllowed || entry.offlineAllowed || entry.mixAllowed) {
      throw new Error(`${entry.externalId}: development audio cannot claim commercial rights`);
    }
  } else if (sourceType === "PROVIDER") {
    if (![entry.rightsHolder, entry.rightsEvidenceRef].every((v) => typeof v === "string" && v.trim())) {
      throw new Error(`${entry.externalId}: rights holder and evidence reference required`);
    }
    if (!entry.distributionAllowed || !entry.offlineAllowed || !entry.mixAllowed) throw new Error(`${entry.externalId}: rights do not cover offline DJ use`);
    if (!["CC_BY", "CC0", "PUBLIC_DOMAIN", "DIRECT_LICENSE", "LABEL_CONTRACT"].includes(entry.rightsBasis ?? "")) throw new Error(`${entry.externalId}: invalid rights basis`);
    if (entry.rightsBasis === "CC_BY" && !entry.attributionUrl?.startsWith("https://")) throw new Error(`${entry.externalId}: CC BY attribution URL required`);
  }
  if (entry.rightsBasis !== undefined && !["CC_BY", "CC0", "PUBLIC_DOMAIN", "DIRECT_LICENSE", "LABEL_CONTRACT"].includes(entry.rightsBasis)) {
    throw new Error(`${entry.externalId}: invalid rights basis`);
  }
  for (const flag of [entry.distributionAllowed, entry.offlineAllowed, entry.mixAllowed]) {
    if (flag !== undefined && typeof flag !== "boolean") throw new Error(`${entry.externalId}: rights permissions must be booleans`);
  }
  if (!["ANY", "GOSPEL", "BONGO", "SECULAR", "WORSHIP"].includes(entry.category)) throw new Error(`${entry.externalId}: invalid category`);
  if (entry.genre !== undefined && (typeof entry.genre !== "string" || entry.genre.length > 120)) throw new Error(`${entry.externalId}: invalid genre`);
  if (!["UNKNOWN", "SWAHILI", "ENGLISH", "KIKUYU"].includes(entry.language)) throw new Error(`${entry.externalId}: invalid language`);
  if (entry.year !== undefined && (!Number.isInteger(entry.year) || entry.year < 1900 || entry.year > 2100)) throw new Error(`${entry.externalId}: invalid release year`);
  if (entry.durationMs !== undefined && (!Number.isFinite(entry.durationMs) || entry.durationMs < 0)) throw new Error(`${entry.externalId}: invalid duration`);
  if (entry.bpm !== undefined && (!Number.isInteger(entry.bpm) || entry.bpm < 40 || entry.bpm > 240)) throw new Error(`${entry.externalId}: invalid BPM`);
  if (entry.musicalKey !== undefined && (typeof entry.musicalKey !== "string" || entry.musicalKey.length > 32)) throw new Error(`${entry.externalId}: invalid musical key`);
  if (entry.energy !== undefined && (!Number.isFinite(entry.energy) || entry.energy < 0 || entry.energy > 1)) throw new Error(`${entry.externalId}: invalid energy`);
  if (entry.rightsExpiresAt && (Number.isNaN(Date.parse(entry.rightsExpiresAt)) || Date.parse(entry.rightsExpiresAt) <= Date.now())) throw new Error(`${entry.externalId}: rights expired`);
}

export async function importManifest(manifest: Manifest, base: string,
  submitter?: StaffPrincipal | "system:provider-sync") {
  const submitterSubject = submitter === "system:provider-sync" ? submitter
    : submitter ? requireStaffRole(submitter, "PARTNER_REGISTRAR") : null;
  const sourceType = manifest.sourceType ?? "PROVIDER";
  if (!manifest.providerId?.trim() || !Array.isArray(manifest.tracks) ||
      !["PROVIDER", "ARTIST", "LOCAL_IMPORT", "DEVELOPMENT_TEST"].includes(sourceType)) {
    throw new Error("Manifest needs providerId, sourceType, and tracks array");
  }
  if (manifest.sourceFeedUrl && (sourceType !== "PROVIDER" || !manifest.sourceFeedUrl.startsWith("https://"))) {
    throw new Error("Provider feed reference must be HTTPS");
  }
  let imported = 0;
  let unchanged = 0;
  for (const entry of manifest.tracks) {
    validate(entry, sourceType);
    const source = path.resolve(base, entry.audioFile);
    if (!source.startsWith(base + path.sep)) throw new Error(`${entry.externalId}: audio path escapes manifest directory`);
    const audio = await inspectAudioFile(source);
    if (sourceType === "DEVELOPMENT_TEST" && audio.mimeType !== "audio/wav") throw new Error("Development audio must be PCM WAV");
    if (entry.durationMs !== undefined && audio.durationMs !== null && Math.abs(entry.durationMs - audio.durationMs) > 20) {
      throw new Error(`${entry.externalId}: duration does not match audio`);
    }
    const { audioFile: _localPath, ...metadata } = entry;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      sourceType, sourceFeedUrl: manifest.sourceFeedUrl ?? null, metadata, audioSha256: audio.sha256,
    })).digest("hex");
    const existing = await db().query<{ id: string; storage_key: string; sha256: string; byte_size: string; import_fingerprint: string | null }>(
      "SELECT id, storage_key, sha256, byte_size, import_fingerprint FROM catalog_tracks WHERE provider_id = $1 AND external_id = $2",
      [manifest.providerId, entry.externalId],
    );
    if (sourceType === "DEVELOPMENT_TEST" || sourceType === "LOCAL_IMPORT") {
      const duplicate = await db().query<{ provider_id: string; external_id: string }>(
        "SELECT provider_id, external_id FROM catalog_tracks WHERE source_type = $1 AND sha256 = $2",
        [sourceType, audio.sha256],
      );
      if (duplicate.rows.some((row) => row.provider_id !== manifest.providerId || row.external_id !== entry.externalId)) {
        if (sourceType === "LOCAL_IMPORT") { unchanged++; continue; }
        throw new Error(`${entry.externalId}: development audio checksum already imported under another ID`);
      }
    }
    const id = existing.rows[0]?.id || randomUUID();
    let sameAudio = false;
    if (existing.rows[0]?.storage_key && !/^[a-f0-9-]{36}\.(mp3|m4a|ogg|flac|wav)$/i.test(existing.rows[0].storage_key)) {
      throw new Error(`${entry.externalId}: invalid stored audio key`);
    }
    if (existing.rows[0]?.sha256 === audio.sha256) {
      const old = await mediaStore().head(existing.rows[0].storage_key);
      sameAudio = old?.bytes === audio.byteSize && old.sha256 === audio.sha256;
    }
    if (sameAudio && existing.rows[0].import_fingerprint === fingerprint) { unchanged++; continue; }
    const storageKey = sameAudio ? existing.rows[0].storage_key : `${randomUUID()}${audio.extension}`;
    if (!sameAudio) await mediaStore().put(storageKey, audio.bytes, audio.mimeType, audio.sha256);
    try {
      const fields = ["id", "provider_id", "external_id", "title", "artist", "album", "release_year",
        "category", "language", "duration_ms", "rights_holder", "rights_basis", "rights_evidence_ref",
        "attribution_url", "distribution_allowed", "offline_allowed", "mix_allowed", "rights_expires_at",
        "storage_key", "mime_type", "byte_size", "sha256", "bpm", "musical_key", "energy", "genre",
        "source_type", "source_feed_url", "development_only", "published", "import_fingerprint", "submitted_by_subject"];
      const values = [id, manifest.providerId.trim(), entry.externalId.trim(), entry.title.trim(), entry.artist.trim(),
        entry.album?.trim() || null, entry.year ?? null, entry.category, entry.language,
        audio.durationMs ?? entry.durationMs ?? 0, entry.rightsHolder?.trim() || null, entry.rightsBasis ?? null,
        entry.rightsEvidenceRef?.trim() || null, entry.attributionUrl ?? null,
        sourceType === "DEVELOPMENT_TEST" ? false : entry.distributionAllowed ?? false,
        sourceType === "DEVELOPMENT_TEST" ? false : entry.offlineAllowed ?? false,
        sourceType === "DEVELOPMENT_TEST" ? false : entry.mixAllowed ?? false,
        entry.rightsExpiresAt ?? null, storageKey, audio.mimeType, audio.byteSize, audio.sha256,
        entry.bpm ?? null, entry.musicalKey ?? null, entry.energy ?? null, entry.genre?.trim() || null,
        sourceType, manifest.sourceFeedUrl ?? null, sourceType === "DEVELOPMENT_TEST", false, fingerprint,
        sourceType === "DEVELOPMENT_TEST" ? null : submitterSubject];
      const updates = fields.slice(3).map((field) => `${field}=excluded.${field}`).join(", ");
      await db().query(`INSERT INTO catalog_tracks (${fields.join(", ")}) VALUES (${fields.map((_, n) => `$${n + 1}`).join(", ")})
        ON CONFLICT (provider_id, external_id) DO UPDATE SET ${updates}, updated_at=CURRENT_TIMESTAMP`, values);
    } catch (error) {
      if (!sameAudio) await mediaStore().delete(storageKey).catch(() => undefined);
      throw error;
    }
    if (existing.rows[0]?.storage_key && !sameAudio) await mediaStore().delete(existing.rows[0].storage_key).catch(() => undefined);
    imported++;
  }
  console.log(`Imported ${imported} track(s); ${unchanged} unchanged. Source: ${sourceType}. New tracks remain unpublished.`);
  return { imported, unchanged };
}

export async function importCatalog(manifestPath: string,
  submitter?: StaffPrincipal | "system:provider-sync") {
  if (!manifestPath) throw new Error("Usage: pnpm catalog:import-manifest <manifest.json>");
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8")) as Manifest;
  return importManifest(manifest, path.dirname(absoluteManifest), submitter);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/import-catalog.ts")) {
  (async () => {
    const manifest = JSON.parse(await readFile(path.resolve(process.argv[2]), "utf8")) as Manifest;
    const staff = manifest.sourceType === "DEVELOPMENT_TEST" ? undefined
      : await staffFromEnvironment("PARTNER_REGISTRAR");
    return importCatalog(process.argv[2], staff);
  })()
    .then(() => db().end())
    .catch((error) => { console.error(error); process.exitCode = 1;
      if (process.env.CLOUDFLARE_D1_DATABASE_ID) db().end().catch(() => undefined); });
}
