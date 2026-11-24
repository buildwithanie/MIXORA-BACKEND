import { db } from "./db";

function temporaryConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return ["AbortError", "TimeoutError"].includes(error.name) ||
    /fetch failed|Cloudflare D1 unavailable \(5\d\d\)/i.test(error.message);
}

async function catalogQuery<T extends object>(sql: string, values?: unknown[]): Promise<T[]> {
  try {
    return (await db().query<T>(sql, values)).rows;
  } catch (error) {
    if (!temporaryConnectionFailure(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return (await db().query<T>(sql, values)).rows;
  }
}

export type CatalogRow = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  release_year: number | null;
  category: string;
  genre: string | null;
  language: string;
  duration_ms: string;
  bpm: number | null;
  musical_key: string | null;
  energy: number | null;
  rights_holder: string;
  rights_basis: string;
  attribution_url: string | null;
  rights_expires_at: string | null;
  storage_key: string;
  mime_type: string;
  byte_size: string;
  sha256: string;
};

const approvedReview = `EXISTS (
        SELECT 1 FROM catalog_rights_reviews r
        JOIN catalog_partners p ON p.partner_id = catalog_tracks.provider_id
        WHERE r.track_id = catalog_tracks.id AND r.decision = 'APPROVED'
          AND r.review_seq = (SELECT max(review_seq) FROM catalog_rights_reviews WHERE track_id = catalog_tracks.id)
          AND r.import_fingerprint = catalog_tracks.import_fingerprint
          AND r.audio_sha256 = catalog_tracks.sha256
          AND r.rights_evidence_ref = catalog_tracks.rights_evidence_ref
          AND p.status = 'VERIFIED' AND p.review_status = 'APPROVED'
          AND EXISTS (SELECT 1 FROM catalog_agreements a
            WHERE a.agreement_id=p.agreement_ref AND a.partner_id=p.partner_id
              AND a.verification_status='VERIFIED' AND a.sha256=p.agreement_sha256
              AND a.distribution_allowed=1 AND a.offline_allowed=1 AND a.mix_allowed=1
              AND a.valid_from<=date('now')
              AND (a.valid_until IS NULL OR a.valid_until>=date('now')))
          AND ((catalog_tracks.source_type = 'ARTIST' AND p.kind = 'ARTIST')
            OR (catalog_tracks.source_type = 'PROVIDER' AND p.kind IN ('DISTRIBUTOR', 'LABEL'))
            OR catalog_tracks.source_type = 'LOCAL_IMPORT')
      )`;

export async function publishedTracks(): Promise<CatalogRow[]> {
  return catalogQuery<CatalogRow>(`
    SELECT id, title, artist, album, release_year, category, genre, language,
           duration_ms, bpm, musical_key, energy, rights_holder, rights_basis, attribution_url,
           rights_expires_at, storage_key, mime_type, byte_size, sha256
    FROM catalog_tracks
    WHERE published=1 AND source_type IN ('PROVIDER', 'ARTIST', 'LOCAL_IMPORT') AND development_only=0
      AND distribution_allowed=1 AND offline_allowed=1 AND mix_allowed=1
      AND rights_holder IS NOT NULL AND length(trim(rights_holder)) > 0
      AND rights_basis IS NOT NULL
      AND (rights_basis <> 'CC_BY' OR attribution_url LIKE 'https://%')
      AND rights_evidence_ref IS NOT NULL AND length(trim(rights_evidence_ref)) > 0
      AND (rights_expires_at IS NULL OR datetime(rights_expires_at) > datetime('now'))
      AND ${approvedReview}
    ORDER BY artist, title, id
  `);
}

export async function publishedTrack(id: string): Promise<CatalogRow | null> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  const rows = await catalogQuery<CatalogRow>(`
    SELECT id, title, artist, album, release_year, category, genre, language,
           duration_ms, bpm, musical_key, energy, rights_holder, rights_basis, attribution_url,
           rights_expires_at, storage_key, mime_type, byte_size, sha256
    FROM catalog_tracks
    WHERE id = $1 AND published=1 AND source_type IN ('PROVIDER', 'ARTIST', 'LOCAL_IMPORT') AND development_only=0
      AND distribution_allowed=1 AND offline_allowed=1 AND mix_allowed=1
      AND rights_holder IS NOT NULL AND length(trim(rights_holder)) > 0
      AND rights_basis IS NOT NULL
      AND (rights_basis <> 'CC_BY' OR attribution_url LIKE 'https://%')
      AND rights_evidence_ref IS NOT NULL AND length(trim(rights_evidence_ref)) > 0
      AND (rights_expires_at IS NULL OR datetime(rights_expires_at) > datetime('now'))
      AND ${approvedReview}
  `, [id]);
  return rows[0] ?? null;
}

