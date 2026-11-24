import { createHash } from "node:crypto";
import { appendAuditEvent, hashEvidenceFile, submissionFingerprint } from "./audit";
import { retrieveAgreement } from "./agreements";
import { db } from "./db";
import { mediaStore } from "./media-store";
import { requireStaffRole } from "./staff-auth";
import type { StaffPrincipal } from "./staff-auth";

const trackIdPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const partnerPattern = /^[a-z0-9][a-z0-9._:-]{2,119}$/i;

type Partner = {
  partner_id: string; kind: string; display_name: string; status: string;
  review_status: string; submitted_by_subject: string | null;
  submission_fingerprint: string | null; agreement_ref: string | null;
  agreement_sha256: string | null;
};

async function partnerForReview(id: string): Promise<Partner | null> {
  if (!partnerPattern.test(id)) throw new Error("Invalid partner ID");
  const result = await db().query<Partner>(
    "SELECT partner_id, kind, display_name, status, review_status, submitted_by_subject, submission_fingerprint, agreement_ref, agreement_sha256 FROM catalog_partners WHERE partner_id=$1", [id]);
  return result.rows[0] ?? null;
}

export async function registerPartner(partnerId: string, kind: string, displayName: string, staff: StaffPrincipal): Promise<boolean> {
  const submitter = requireStaffRole(staff, "PARTNER_REGISTRAR");
  if (!partnerPattern.test(partnerId) || !["ARTIST", "DISTRIBUTOR", "LABEL"].includes(kind) ||
      !displayName?.trim() || displayName.length > 160) throw new Error("Invalid partner ID, kind, or name");
  const name = displayName.trim();
  const fingerprint = submissionFingerprint({ partnerId, kind, displayName: name, submitter });
  const result = await db().query<{ partner_id: string }>(
    `INSERT INTO catalog_partners (partner_id, kind, display_name, submitted_by_subject, submission_fingerprint)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (partner_id) DO NOTHING RETURNING partner_id`,
    [partnerId, kind, name, submitter, fingerprint]);
  return result.rows.length === 1;
}

export async function verifyPartner(partnerId: string, agreementRef: string, file: string,
  reason: string, staff: StaffPrincipal): Promise<boolean> {
  const actor = requireStaffRole(staff, "PARTNER_VERIFIER");
  if (!partnerPattern.test(partnerId) || !agreementRef?.trim() || agreementRef.length > 200) {
    throw new Error("Invalid partner or agreement reference");
  }
  const partner = await partnerForReview(partnerId);
  if (!partner || partner.status !== "PENDING" || partner.review_status !== "PENDING" ||
      !partner.submission_fingerprint || !partner.submitted_by_subject ||
      partner.submitted_by_subject === actor) return false;
  const hash = await hashEvidenceFile(file);
  const agreements = await db().query<{
    agreement_id: string; sha256: string; uploaded_by_subject: string;
  }>("SELECT agreement_id, sha256, uploaded_by_subject FROM catalog_agreements " +
      "WHERE agreement_id=$1 AND partner_id=$2 AND verification_status='VERIFIED' " +
      "AND agreement_type=$3 AND distribution_allowed=1 AND offline_allowed=1 " +
      "AND mix_allowed=1 AND valid_from<=date('now') " +
      "AND (valid_until IS NULL OR valid_until>=date('now'))",
    [agreementRef.trim(), partnerId, partner.kind]);
  if (!agreements.rows[0] || agreements.rows[0].sha256 !== hash ||
      agreements.rows[0].uploaded_by_subject === actor) return false;
  const storedDocument = await retrieveAgreement(agreementRef.trim(), staff);
  if (!storedDocument) return false;
  if (createHash("sha256").update(storedDocument).digest("hex") !== hash) return false;
  return appendAuditEvent({
    entity_type: "PARTNER", entity_id: partnerId, partner_id: partnerId,
    decision: "APPROVED", actor_subject: actor, actor_role: "PARTNER_VERIFIER", reason,
    metadata_version: partner.submission_fingerprint, audio_sha256: null,
    evidence_sha256: hash, agreement_sha256: hash, agreement_ref: agreementRef.trim(),
    rights_evidence_ref: null, submitted_by_subject: partner.submitted_by_subject,
  });
}

export async function rejectPartner(partnerId: string, file: string, reason: string,
  staff: StaffPrincipal): Promise<boolean> {
  const actor = requireStaffRole(staff, "PARTNER_VERIFIER");
  const partner = await partnerForReview(partnerId);
  if (!partner || partner.status !== "PENDING" || partner.review_status !== "PENDING" ||
      !partner.submission_fingerprint || !partner.submitted_by_subject ||
      partner.submitted_by_subject === actor) return false;
  return appendAuditEvent({
    entity_type: "PARTNER", entity_id: partnerId, partner_id: partnerId,
    decision: "REJECTED", actor_subject: actor, actor_role: "PARTNER_VERIFIER", reason,
    metadata_version: partner.submission_fingerprint, audio_sha256: null,
    evidence_sha256: await hashEvidenceFile(file), agreement_sha256: null,
    agreement_ref: null, rights_evidence_ref: null,
    submitted_by_subject: partner.submitted_by_subject,
  });
}

export async function revokePartner(partnerId: string, file: string, reason: string,
  staff: StaffPrincipal): Promise<boolean> {
  const actor = requireStaffRole(staff, "REVOKER");
  const partner = await partnerForReview(partnerId);
  if (!partner || partner.status !== "VERIFIED" || !partner.submission_fingerprint) return false;
  return appendAuditEvent({
    entity_type: "PARTNER", entity_id: partnerId, partner_id: partnerId,
    decision: "REVOKED", actor_subject: actor, actor_role: "REVOKER", reason,
    metadata_version: partner.submission_fingerprint, audio_sha256: null,
    evidence_sha256: await hashEvidenceFile(file), agreement_sha256: partner.agreement_sha256,
    agreement_ref: partner.agreement_ref, rights_evidence_ref: null,
    submitted_by_subject: partner.submitted_by_subject,
  });
}

type Candidate = {
  id: string; provider_id: string; source_type: string; development_only: number;
  distribution_allowed: number; offline_allowed: number; mix_allowed: number;
  rights_holder: string | null; rights_basis: string | null; rights_evidence_ref: string | null;
  attribution_url: string | null; rights_expires_at: string | null;
  storage_key: string; byte_size: number; mime_type: string; sha256: string;
  import_fingerprint: string | null; submitted_by_subject: string | null;
  partner_kind: string | null; partner_status: string | null; partner_review_status: string | null;
  partner_verified_by: string | null; partner_submitted_by: string | null;
  partner_agreement_sha256: string | null;
};

async function trackForReview(id: string): Promise<Candidate | null> {
  if (!trackIdPattern.test(id)) throw new Error("Provide a valid track UUID");
  const result = await db().query<Candidate>(`
    SELECT c.*, p.kind AS partner_kind, p.status AS partner_status,
      p.review_status AS partner_review_status, p.verified_by AS partner_verified_by,
      p.submitted_by_subject AS partner_submitted_by,
      p.agreement_sha256 AS partner_agreement_sha256
    FROM catalog_tracks c LEFT JOIN catalog_partners p ON p.partner_id=c.provider_id WHERE c.id=$1`, [id]);
  return result.rows[0] ?? null;
}

export async function approveTrack(id: string, evidenceFile: string, reason: string,
  staff: StaffPrincipal): Promise<boolean> {
  const actor = requireStaffRole(staff, "RIGHTS_REVIEWER");
  const row = await trackForReview(id);
  if (!row || row.development_only || !["PROVIDER", "ARTIST", "LOCAL_IMPORT"].includes(row.source_type) ||
      row.partner_status !== "VERIFIED" || row.partner_review_status !== "APPROVED" ||
      row.partner_verified_by === actor || row.partner_submitted_by === actor ||
      !row.submitted_by_subject || row.submitted_by_subject === actor ||
      (row.source_type === "ARTIST" && row.partner_kind !== "ARTIST") ||
      (row.source_type === "PROVIDER" && !["DISTRIBUTOR", "LABEL"].includes(row.partner_kind ?? "")) ||
      !row.distribution_allowed || !row.offline_allowed || !row.mix_allowed ||
      !row.rights_holder?.trim() || !row.rights_basis || !row.rights_evidence_ref?.trim() ||
      !row.import_fingerprint || !row.partner_agreement_sha256 ||
      (row.rights_basis === "CC_BY" && !row.attribution_url?.startsWith("https://")) ||
      (row.rights_expires_at && (!Number.isFinite(Date.parse(row.rights_expires_at)) ||
        Date.parse(row.rights_expires_at) <= Date.now()))) return false;
  const object = await mediaStore().head(row.storage_key);
  if (!object || object.bytes !== Number(row.byte_size) || object.sha256 !== row.sha256 || object.mimeType !== row.mime_type) return false;
  return appendAuditEvent({
    entity_type: "TRACK", entity_id: id, partner_id: row.provider_id,
    decision: "APPROVED", actor_subject: actor, actor_role: "RIGHTS_REVIEWER", reason,
    metadata_version: row.import_fingerprint, audio_sha256: row.sha256,
    evidence_sha256: await hashEvidenceFile(evidenceFile),
    agreement_sha256: row.partner_agreement_sha256, agreement_ref: null,
    rights_evidence_ref: row.rights_evidence_ref,
    submitted_by_subject: row.submitted_by_subject,
  });
}

export async function rejectTrack(id: string, evidenceFile: string, reason: string,
  staff: StaffPrincipal): Promise<boolean> {
  const actor = requireStaffRole(staff, "RIGHTS_REVIEWER");
  const row = await trackForReview(id);
  if (!row?.import_fingerprint || !row.submitted_by_subject || row.submitted_by_subject === actor) return false;
  return appendAuditEvent({
    entity_type: "TRACK", entity_id: id, partner_id: row.provider_id,
    decision: "REJECTED", actor_subject: actor, actor_role: "RIGHTS_REVIEWER", reason,
    metadata_version: row.import_fingerprint, audio_sha256: row.sha256,
    evidence_sha256: await hashEvidenceFile(evidenceFile),
    agreement_sha256: row.partner_agreement_sha256, agreement_ref: null,
    rights_evidence_ref: row.rights_evidence_ref,
    submitted_by_subject: row.submitted_by_subject,
  });
}

export async function revokeReview(providerId: string, externalId: string,
  actor: StaffPrincipal | "system:provider-sync", reason: string,
  evidenceFile?: string): Promise<boolean> {
  const subject = actor === "system:provider-sync" ? actor : requireStaffRole(actor, "REVOKER");
  const result = await db().query<{ id: string }>(
    "SELECT id FROM catalog_tracks WHERE provider_id=$1 AND external_id=$2", [providerId, externalId]);
  const row = result.rows[0] ? await trackForReview(result.rows[0].id) : null;
  if (!row?.import_fingerprint) return false;
  if (subject !== "system:provider-sync" && !evidenceFile) throw new Error("Revocation evidence file required");
  return appendAuditEvent({
    entity_type: "TRACK", entity_id: row.id, partner_id: providerId,
    decision: subject === "system:provider-sync" ? "SOURCE_WITHDRAWN" : "REVOKED",
    actor_subject: subject,
    actor_role: subject === "system:provider-sync" ? "SYSTEM" : "REVOKER", reason,
    metadata_version: row.import_fingerprint, audio_sha256: row.sha256,
    evidence_sha256: evidenceFile ? await hashEvidenceFile(evidenceFile) : null,
    agreement_sha256: row.partner_agreement_sha256, agreement_ref: null,
    rights_evidence_ref: row.rights_evidence_ref,
    submitted_by_subject: row.submitted_by_subject,
  });
}

