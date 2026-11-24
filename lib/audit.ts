import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { db } from "./db";

export type AuditDecision = "APPROVED" | "REJECTED" | "REVOKED" | "SOURCE_WITHDRAWN";
export type AuditEntity = "PARTNER" | "TRACK";
export type AuditEvent = {
  event_id: string; entity_type: AuditEntity; entity_id: string; partner_id: string;
  decision: AuditDecision; actor_subject: string; actor_role: string; reason: string;
  recorded_at: string; metadata_version: string; audio_sha256: string | null;
  evidence_sha256: string | null; agreement_sha256: string | null;
  agreement_ref: string | null; rights_evidence_ref: string | null;
  submitted_by_subject: string | null; previous_hash: string; event_hash: string;
};
export type NewAuditEvent = Omit<AuditEvent, "event_id" | "recorded_at" | "previous_hash" | "event_hash">;
const genesis = "0".repeat(64);
const fields = ["event_id", "entity_type", "entity_id", "partner_id", "decision",
  "actor_subject", "actor_role", "reason", "recorded_at", "metadata_version",
  "audio_sha256", "evidence_sha256", "agreement_sha256", "agreement_ref",
  "rights_evidence_ref", "submitted_by_subject", "previous_hash", "event_hash"] as const;

function auditKey(): Buffer {
  const value = process.env.MIXORA_AUDIT_HMAC_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("MIXORA audit HMAC key is not configured");
  return Buffer.from(value, "hex");
}

function eventDigest(event: Omit<AuditEvent, "event_hash">): string {
  const payload = JSON.stringify([
    1, event.event_id, event.entity_type, event.entity_id, event.partner_id,
    event.decision, event.actor_subject, event.actor_role, event.reason,
    event.recorded_at, event.metadata_version, event.audio_sha256,
    event.evidence_sha256, event.agreement_sha256, event.agreement_ref,
    event.rights_evidence_ref, event.submitted_by_subject, event.previous_hash,
  ]);
  return createHmac("sha256", auditKey()).update(payload).digest("hex");
}

export function submissionFingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function hashEvidenceFile(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 10 * 1024 * 1024) {
    throw new Error("Evidence must be a nonempty file of at most 10 MB");
  }
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function appendAuditEvent(input: NewAuditEvent): Promise<boolean> {
  if (input.reason.trim().length < 8 || input.reason.length > 1000) {
    throw new Error("Decision reason must be 8-1000 characters");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await db().query<{ event_hash: string }>(
      "SELECT event_hash FROM catalog_review_events ORDER BY event_seq DESC LIMIT 1");
    const unsigned = {
      ...input, reason: input.reason.trim(), event_id: randomUUID(),
      recorded_at: new Date().toISOString(), previous_hash: head.rows[0]?.event_hash ?? genesis,
    };
    const event: AuditEvent = { ...unsigned, event_hash: eventDigest(unsigned) };
    const result = await db().query<{ event_id: string }>(`
      INSERT INTO catalog_review_events (${fields.join(", ")})
      SELECT ${fields.map((_, index) => `$${index + 1}`).join(", ")}
      WHERE COALESCE((SELECT event_hash FROM catalog_review_events ORDER BY event_seq DESC LIMIT 1),
        '${genesis}')=$${fields.length - 1}
      RETURNING event_id`, fields.map((field) => event[field]));
    if (result.rows.length) return true;
  }
  throw new Error("Audit chain changed during decision; retry later");
}

export async function verifyAuditHistory(): Promise<number> {
  const history = await db().query<AuditEvent>(
    `SELECT ${fields.join(", ")} FROM catalog_review_events ORDER BY event_seq`);
  let previous = genesis;
  for (const event of history.rows) {
    if (event.previous_hash !== previous || !/^[a-f0-9]{64}$/i.test(event.event_hash)) {
      throw new Error("Audit history chain mismatch");
    }
    const { event_hash: _stored, ...unsigned } = event;
    const expected = eventDigest(unsigned);
    if (!timingSafeEqual(Buffer.from(event.event_hash, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("Audit history signature mismatch");
    }
    previous = event.event_hash;
  }
  return history.rows.length;
}