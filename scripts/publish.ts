import "../lib/load-env";
import { db } from "../lib/db";
import { mediaStore } from "../lib/media-store";
import { requireStaffRole, staffFromEnvironment } from "../lib/staff-auth";
import type { StaffPrincipal } from "../lib/staff-auth";

export async function publishTrack(id: string, staff: StaffPrincipal): Promise<boolean> {
  const publisher = requireStaffRole(staff, "PUBLISHER");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error("Provide a valid track UUID");
  }
  const candidate = await db().query<{ storage_key: string; sha256: string; byte_size: number; mime_type: string }>(
    "SELECT storage_key, sha256, byte_size, mime_type FROM catalog_tracks WHERE id=$1", [id]);
  if (!candidate.rows[0]) return false;
  const row = candidate.rows[0];
  const object = await mediaStore().head(row.storage_key);
  if (!object || object.bytes !== Number(row.byte_size) || object.sha256 !== row.sha256 || object.mimeType !== row.mime_type) return false;
  const result = await db().query<{ id: string }>(`
    UPDATE catalog_tracks SET published=1, updated_at=CURRENT_TIMESTAMP
    WHERE id=$1 AND source_type IN ('PROVIDER', 'ARTIST', 'LOCAL_IMPORT') AND development_only=0
      AND distribution_allowed=1 AND offline_allowed=1 AND mix_allowed=1
      AND rights_holder IS NOT NULL AND length(trim(rights_holder)) > 0
      AND rights_basis IS NOT NULL
      AND (rights_basis <> 'CC_BY' OR attribution_url LIKE 'https://%')
      AND rights_evidence_ref IS NOT NULL AND length(trim(rights_evidence_ref)) > 0
      AND (rights_expires_at IS NULL OR datetime(rights_expires_at) > datetime('now'))
      AND EXISTS (SELECT 1 FROM catalog_rights_reviews r
        JOIN catalog_partners p ON p.partner_id = catalog_tracks.provider_id
        WHERE r.track_id = catalog_tracks.id AND r.decision='APPROVED'
          AND r.review_seq = (SELECT max(review_seq) FROM catalog_rights_reviews WHERE track_id = catalog_tracks.id)
          AND r.import_fingerprint = catalog_tracks.import_fingerprint
          AND r.audio_sha256 = catalog_tracks.sha256
          AND r.rights_evidence_ref = catalog_tracks.rights_evidence_ref
          AND r.reviewer_id <> $2
          AND p.status='VERIFIED'
          AND ((catalog_tracks.source_type='ARTIST' AND p.kind='ARTIST')
            OR (catalog_tracks.source_type='PROVIDER' AND p.kind IN ('DISTRIBUTOR', 'LABEL'))
            OR catalog_tracks.source_type='LOCAL_IMPORT'))
    RETURNING id
  `, [id, publisher]);
  return result.rows.length === 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/publish.ts")) {
  staffFromEnvironment("PUBLISHER")
    .then((staff) => publishTrack(process.argv[2] ?? "", staff))
    .then((published) => { console.log(published ? "Track published" : "Track ineligible or missing");
      if (!published) process.exitCode = 1; })
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => db().end().catch(() => undefined));
}
