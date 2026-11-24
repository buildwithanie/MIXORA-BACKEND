import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { submissionFingerprint } from "./audit";

export type AgreementSnapshot = {
  agreement_id: string; partner_id: string; agreement_type: string;
  grantor: string; grantee: string; distribution_allowed: number; offline_allowed: number;
  mix_allowed: number; valid_from: string; valid_until: string | null;
  object_key: string; byte_size: number; sha256: string; uploaded_by_subject: string;
  metadata_version: string;
};
export function agreementMetadataFingerprint(row: AgreementSnapshot): string {
  return submissionFingerprint({
    partnerId: row.partner_id, agreementType: row.agreement_type,
    grantor: row.grantor.trim(), grantee: row.grantee.trim(),
    distributionAllowed: Boolean(row.distribution_allowed),
    offlineAllowed: Boolean(row.offline_allowed), mixAllowed: Boolean(row.mix_allowed),
    validFrom: row.valid_from, validUntil: row.valid_until,
    id: row.agreement_id, key: row.object_key, sha: row.sha256,
    byteSize: Number(row.byte_size), subject: row.uploaded_by_subject,
  });
}export type AgreementAction = "UPLOADED" | "INSPECTED" | "RETRIEVED" | "VERIFIED" | "REJECTED" | "REVOKED";
export type AgreementEvent = {
  event_id: string; agreement_id: string; action: AgreementAction; actor_subject: string;
  actor_role: string; reason: string; recorded_at: string; metadata_version: string;
  document_sha256: string; previous_hash: string; event_hash: string;
};
export type NewAgreementEvent = Omit<AgreementEvent, "event_id" | "recorded_at" | "previous_hash" | "event_hash">;
const genesis = "0".repeat(64);
const fields = ["event_id", "agreement_id", "action", "actor_subject", "actor_role", "reason",
  "recorded_at", "metadata_version", "document_sha256", "previous_hash", "event_hash"] as const;
function digest(event: Omit<AgreementEvent, "event_hash">): string {
  const key = process.env.MIXORA_AUDIT_HMAC_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("MIXORA audit HMAC key is not configured");
  return createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify([
    "mixora-agreement-audit-v1", event.event_id, event.agreement_id, event.action,
    event.actor_subject, event.actor_role, event.reason, event.recorded_at,
    event.metadata_version, event.document_sha256, event.previous_hash,
  ])).digest("hex");
}
export async function appendAgreementEvent(input: NewAgreementEvent): Promise<void> {
  if (input.reason.trim().length < 8 || input.reason.length > 1000) throw new Error("Agreement reason must be 8-1000 characters");
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await db().query<{ event_hash: string }>(
      "SELECT event_hash FROM catalog_agreement_events ORDER BY event_seq DESC LIMIT 1");
    const unsigned = { ...input, reason: input.reason.trim(), event_id: randomUUID(),
      recorded_at: new Date().toISOString(), previous_hash: head.rows[0]?.event_hash ?? genesis };
    const event: AgreementEvent = { ...unsigned, event_hash: digest(unsigned) };
    const result = await db().query<{ event_id: string }>(
      "INSERT INTO catalog_agreement_events (" + fields.join(", ") + ") SELECT " +
        fields.map((_, index) => "$" + (index + 1)).join(", ") +
        " WHERE COALESCE((SELECT event_hash FROM catalog_agreement_events ORDER BY event_seq DESC LIMIT 1), '" +
        genesis + "')=$10 RETURNING event_id",
      fields.map((field) => event[field]));
    if (result.rows.length) return;
  }
  throw new Error("Agreement audit chain changed; retry later");
}
export async function verifyAgreementAuditHistory(): Promise<number> {
  const history = await db().query<AgreementEvent>(
    "SELECT " + fields.join(", ") + " FROM catalog_agreement_events ORDER BY event_seq");
  const records = await db().query<AgreementSnapshot>("SELECT * FROM catalog_agreements");
  const snapshots = new Map(records.rows.map((row) => [row.agreement_id, row]));
  let previous = genesis;
  for (const event of history.rows) {
    const snapshot = snapshots.get(event.agreement_id);
    if (!snapshot || snapshot.metadata_version !== event.metadata_version ||
        snapshot.sha256 !== event.document_sha256 ||
        agreementMetadataFingerprint(snapshot) !== event.metadata_version) {
      throw new Error("Agreement metadata snapshot mismatch");
    }
    if (event.previous_hash !== previous || !/^[a-f0-9]{64}$/i.test(event.event_hash)) {
      throw new Error("Agreement audit chain mismatch");
    }
    const { event_hash: _stored, ...unsigned } = event;
    const expected = digest(unsigned);
    if (!timingSafeEqual(Buffer.from(event.event_hash, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("Agreement audit signature mismatch");
    }
    previous = event.event_hash;
  }
  return history.rows.length;
}

