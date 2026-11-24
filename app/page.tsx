import { db } from "../lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  let count: number | null = null;
  try {
    const result = await db().query<{ count: number }>(`SELECT count(*) AS count FROM catalog_tracks
      WHERE published=1 AND source_type IN ('PROVIDER', 'ARTIST', 'LOCAL_IMPORT') AND development_only=0
        AND distribution_allowed=1 AND offline_allowed=1 AND mix_allowed=1
        AND rights_holder IS NOT NULL AND length(trim(rights_holder)) > 0
        AND rights_basis IS NOT NULL
        AND (rights_basis <> 'CC_BY' OR attribution_url LIKE 'https://%')
        AND rights_evidence_ref IS NOT NULL AND length(trim(rights_evidence_ref)) > 0
        AND (rights_expires_at IS NULL OR datetime(rights_expires_at) > datetime('now'))`);
    count = Number(result.rows[0].count);
  } catch {
    // The setup page remains available before Cloudflare D1 is configured.
  }
  return <main style={{ maxWidth: 760, margin: "auto", padding: 32 }}>
    <h1 style={{ color: "#ff73d0" }}>MIXORA Catalog</h1>
    <p>{count === null ? "Database not configured" : `${count} licensed tracks available for offline sync`}</p>
    <p>Only tracks with documented distribution, offline, and mixing rights are published.</p>
    <p>Run the schema migration, then import an authorized provider manifest. Android syncs the published catalog automatically when configured.</p>
    <a href="/api/catalog" style={{ color: "#b99bff" }}>View catalog API</a>
  </main>;
}
