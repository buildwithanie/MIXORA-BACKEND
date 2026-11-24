import { createHash, randomUUID } from "node:crypto";
import { agreementMetadataFingerprint, appendAgreementEvent } from "./agreement-audit";
import { agreementStore } from "./agreement-store";
import { submissionFingerprint } from "./audit";
import { db } from "./db";
import { requireStaffRole, StaffAccessError } from "./staff-auth";
import type { StaffPrincipal, StaffRole } from "./staff-auth";

export type AgreementType = "ARTIST" | "DISTRIBUTOR" | "LABEL" | "ADDENDUM";
export type AgreementInput = {
  partnerId: string; agreementType: AgreementType; grantor: string; grantee: string;
  distributionAllowed: boolean; offlineAllowed: boolean; mixAllowed: boolean;
  validFrom: string; validUntil: string | null;
};
export type AgreementRow = {
  agreement_id: string; partner_id: string; agreement_type: AgreementType;
  grantor: string; grantee: string; distribution_allowed: number; offline_allowed: number;
  mix_allowed: number; valid_from: string; valid_until: string | null; object_key: string;
  mime_type: string; byte_size: number; sha256: string; metadata_version: string;
  uploaded_by_subject: string; uploaded_at: string; verification_status: string;
  verified_by_subject: string | null; verified_at: string | null;
};
export class AgreementError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 | 503) {
    super(message); this.name = "AgreementError";
  }
}
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const partnerId = /^[a-z0-9][a-z0-9._:-]{2,119}$/i;
const shaPattern = /^[a-f0-9]{64}$/i;
const maxBytes = 10 * 1024 * 1024;
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function validate(input: AgreementInput, bytes: Buffer, expectedSha: string): string {
  if (!input || !partnerId.test(input.partnerId) ||
      !["ARTIST", "DISTRIBUTOR", "LABEL", "ADDENDUM"].includes(input.agreementType) ||
      !input.grantor?.trim() || input.grantor.length > 200 || input.grantor.trim().length < 2 ||
      !input.grantee?.trim() || input.grantee.length > 200 || input.grantee.trim().length < 2 ||
      typeof input.distributionAllowed !== "boolean" ||
      typeof input.offlineAllowed !== "boolean" || typeof input.mixAllowed !== "boolean" ||
      !date(input.validFrom) || (input.validUntil !== null && !date(input.validUntil)) ||
      (input.validUntil !== null && input.validUntil < input.validFrom)) {
    throw new AgreementError("Invalid agreement metadata", 400);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > maxBytes ||
      !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
      !bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from("%%EOF"))) {
    throw new AgreementError("A PDF document of at most 10 MB is required", 400);
  }
  if (!shaPattern.test(expectedSha)) throw new AgreementError("Valid SHA-256 checksum required", 400);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha.toLowerCase()) throw new AgreementError("Agreement checksum mismatch", 400);
  return actual;
}
function role(staff: StaffPrincipal, allowed: readonly StaffRole[]): StaffRole {
  for (const item of allowed) {
    try { requireStaffRole(staff, item); return item; } catch (error) {
      if (!(error instanceof StaffAccessError)) throw error;
    }
  }
  throw new StaffAccessError("Staff role required", 403);
}
async function row(id: string): Promise<AgreementRow | null> {
  if (!uuid.test(id)) throw new AgreementError("Agreement unavailable", 404);
  const result = await db().query<AgreementRow>(
    "SELECT a.* FROM catalog_agreements a WHERE a.agreement_id=$1 AND EXISTS " +
    "(SELECT 1 FROM catalog_agreement_events e WHERE e.agreement_id=a.agreement_id " +
    "AND e.action='UPLOADED' AND e.metadata_version=a.metadata_version AND e.document_sha256=a.sha256)", [id]);
  const agreement = result.rows[0] ?? null;
  if (agreement && agreementMetadataFingerprint(agreement) !== agreement.metadata_version) {
    throw new AgreementError("Agreement metadata integrity check failed", 503);
  }
  return agreement;
}
export async function uploadAgreement(input: AgreementInput, bytes: Buffer, expectedSha: string,
  staff: StaffPrincipal): Promise<string> {
  const subject = requireStaffRole(staff, "PARTNER_REGISTRAR");
  const sha = validate(input, bytes, expectedSha);
  const partner = await db().query<{ kind: string }>(
    "SELECT kind FROM catalog_partners WHERE partner_id=$1", [input.partnerId]);
  if (!partner.rows[0]) throw new AgreementError("Partner unavailable", 404);
  if (input.agreementType !== "ADDENDUM" && partner.rows[0].kind !== input.agreementType) {
    throw new AgreementError("Agreement and partner types differ", 400);
  }
  const id = randomUUID();
  const key = "agreements/" + id + ".pdf";
  const version = agreementMetadataFingerprint({
    agreement_id: id, partner_id: input.partnerId, agreement_type: input.agreementType,
    grantor: input.grantor.trim(), grantee: input.grantee.trim(),
    distribution_allowed: Number(input.distributionAllowed),
    offline_allowed: Number(input.offlineAllowed), mix_allowed: Number(input.mixAllowed),
    valid_from: input.validFrom, valid_until: input.validUntil, object_key: key,
    byte_size: bytes.length, sha256: sha, uploaded_by_subject: subject, metadata_version: "",
  });
  try {
    await agreementStore().put(key, bytes, sha);
    const head = await agreementStore().head(key);
    const uploaded = await agreementStore().get(key);
    if (!head || head.byteSize !== bytes.length || head.sha256 !== sha || head.writeId !== id ||
        !uploaded || uploaded.mimeType !== "application/pdf" ||
        uploaded.bytes.length !== bytes.length ||
        createHash("sha256").update(uploaded.bytes).digest("hex") !== sha) {
      throw new AgreementError("Stored agreement checksum or size mismatch", 503);
    }
    await db().query(
      "INSERT INTO catalog_agreements (agreement_id, partner_id, agreement_type, grantor, grantee, " +
      "distribution_allowed, offline_allowed, mix_allowed, valid_from, valid_until, object_key, " +
      "mime_type, byte_size, sha256, metadata_version, uploaded_by_subject) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'application/pdf',$12,$13,$14,$15)",
      [id, input.partnerId, input.agreementType, input.grantor.trim(), input.grantee.trim(),
        Number(input.distributionAllowed), Number(input.offlineAllowed), Number(input.mixAllowed),
        input.validFrom, input.validUntil, key, bytes.length, sha, version, subject]);
    await appendAgreementEvent({ agreement_id: id, action: "UPLOADED", actor_subject: subject,
      actor_role: "PARTNER_REGISTRAR", reason: "Private agreement uploaded",
      metadata_version: version, document_sha256: sha });
    return id;
  } catch (error) {
    // The key is random and create-only. Remove only the bytes this request just wrote.
    // A failed audit leaves a pending D1 row, but row() will never serve it without UPLOADED.
    try {
      const object = await agreementStore().head(key);
      if (object && object.writeId === id) {
        if (object.byteSize !== bytes.length || object.sha256 !== sha) throw new Error("Object changed");
        await agreementStore().delete(key);
      }
    } catch {
      throw new AgreementError("Agreement upload incomplete; storage reconciliation required", 503);
    }
    throw error;
  }
}
export async function inspectAgreement(id: string, staff: StaffPrincipal): Promise<AgreementRow | null> {
  const actorRole = role(staff, ["PARTNER_VERIFIER", "AUDITOR"]);
  const agreement = await row(id);
  if (!agreement) return null;
  await appendAgreementEvent({ agreement_id: id, action: "INSPECTED", actor_subject: staff.subject,
    actor_role: actorRole, reason: "Agreement metadata inspected",
    metadata_version: agreement.metadata_version, document_sha256: agreement.sha256 });
  return agreement;
}
export async function retrieveAgreement(id: string, staff: StaffPrincipal): Promise<Buffer | null> {
  const actorRole = role(staff, ["PARTNER_VERIFIER", "AUDITOR"]);
  const agreement = await row(id);
  if (!agreement) return null;
  const object = await agreementStore().get(agreement.object_key);
  if (!object || object.mimeType !== "application/pdf" || object.bytes.length !== Number(agreement.byte_size) ||
      object.bytes.length > maxBytes || object.sha256 !== agreement.sha256 ||
      createHash("sha256").update(object.bytes).digest("hex") !== agreement.sha256) {
    throw new AgreementError("Agreement integrity check failed", 503);
  }
  await appendAgreementEvent({ agreement_id: id, action: "RETRIEVED", actor_subject: staff.subject,
    actor_role: actorRole, reason: "Private agreement retrieved",
    metadata_version: agreement.metadata_version, document_sha256: agreement.sha256 });
  return object.bytes;
}
export async function decideAgreement(id: string, decision: "VERIFIED" | "REJECTED" | "REVOKED",
  reason: string, staff: StaffPrincipal): Promise<boolean> {
  const actorRole = decision === "REVOKED" ? "REVOKER" : "PARTNER_VERIFIER";
  const subject = requireStaffRole(staff, actorRole);
  const agreement = await row(id);
  if (!agreement) return false;
  if (decision === "REVOKED" ? agreement.verification_status !== "VERIFIED" :
      agreement.verification_status !== "PENDING" || agreement.uploaded_by_subject === subject) return false;
  if (decision === "VERIFIED") {
    const head = await agreementStore().head(agreement.object_key);
    const document = await agreementStore().get(agreement.object_key);
    if (!head || head.byteSize !== Number(agreement.byte_size) || head.sha256 !== agreement.sha256 ||
        !document || document.mimeType !== "application/pdf" ||
        document.bytes.length !== Number(agreement.byte_size) ||
        createHash("sha256").update(document.bytes).digest("hex") !== agreement.sha256 ||
        (agreement.valid_until !== null && agreement.valid_until < new Date().toISOString().slice(0, 10))) return false;
  }
  await appendAgreementEvent({ agreement_id: id, action: decision, actor_subject: subject,
    actor_role: actorRole, reason, metadata_version: agreement.metadata_version,
    document_sha256: agreement.sha256 });
  return true;
}



