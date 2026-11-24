import "../lib/load-env";
import { db } from "../lib/db";
import { mediaStore } from "../lib/media-store";
import { revokeReview } from "../lib/approvals";
import { staffFromEnvironment } from "../lib/staff-auth";

async function main() {
  const providerId = process.argv[2];
  const externalId = process.argv[3];
  const evidenceFile = process.argv[4];
  const reason = process.argv[5];
  if (!providerId || !externalId || !evidenceFile || !reason) throw new Error("Usage: pnpm catalog:unpublish <provider-id> <external-id> <evidence-file> <reason> (CF_ACCESS_JWT required)");
  const staff = await staffFromEnvironment("REVOKER");
  if (!await revokeReview(providerId, externalId, staff, reason, evidenceFile)) throw new Error("Track ineligible for revocation");
  const result = await db().query<{ storage_key: string }>(
    "UPDATE catalog_tracks SET published=0, updated_at=CURRENT_TIMESTAMP WHERE provider_id=$1 AND external_id=$2 RETURNING storage_key",
    [providerId, externalId],
  );
  if (result.rows[0]) {
    await mediaStore().delete(result.rows[0].storage_key).catch(() => undefined);
  }
  console.log(result.rows.length ? "Track unpublished" : "No matching track");
  await db().end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
