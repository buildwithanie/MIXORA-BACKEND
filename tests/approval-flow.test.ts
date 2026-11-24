import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import type { MediaStore } from "../lib/media-store";
import type { AgreementStore } from "../lib/agreement-store";
import { uploadAgreement, decideAgreement } from "../lib/agreements";
import { verifyAuditHistory } from "../lib/audit";
import { approveTrack, registerPartner, rejectPartner, rejectTrack, revokePartner, revokeReview, verifyPartner } from "../lib/approvals";
import { authorizeStaffToken, StaffAccessError } from "../lib/staff-auth";
import type { StaffPrincipal } from "../lib/staff-auth";
import { config, staffFixture } from "./staff-fixtures";

const ids = {
  submitter: "11111111-1111-4111-8111-111111111111",
  verifier: "22222222-2222-4222-8222-222222222222",
  trackSubmitter: "33333333-3333-4333-8333-333333333333",
  reviewer: "44444444-4444-4444-8444-444444444444",
  revoker: "55555555-5555-4555-8555-555555555555",
  outsider: "66666666-6666-4666-8666-666666666666",
};
const audioHash = "a".repeat(64);
const fingerprint = "f".repeat(64);

function addTrack(database: DatabaseSync, id: string, externalId: string): void {
  database.prepare(`INSERT INTO catalog_tracks
    (id, provider_id, external_id, title, artist, category, language, duration_ms,
     storage_key, mime_type, byte_size, sha256, source_type, development_only,
     rights_holder, rights_basis, rights_evidence_ref, distribution_allowed,
     offline_allowed, mix_allowed, import_fingerprint, submitted_by_subject)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, "artist:test", externalId, "Test track", "Test artist", "GOSPEL", "SWAHILI", 5000,
      `${id}.wav`, "audio/wav", 100, audioHash, "ARTIST", 0,
      "Unit-test holder", "DIRECT_LICENSE", "test-evidence-ref", 1, 1, 1,
      fingerprint, ids.trackSubmitter);
}

test("Stage 2 decisions enforce roles, separation of duties, and immutable HMAC audit history", async () => {
  const database = new DatabaseSync(":memory:");
  for (const file of ["schema.sql", "migrations/0002_partner_review.sql",
    "migrations/0003_staff_roles.sql", "migrations/0004_review_audit.sql", "migrations/0005_protected_agreements.sql"]) {
    database.exec(await readFile(path.resolve(file), "utf8"));
  }
  const directory = await mkdtemp(path.join(tmpdir(), "mixora-audit-"));
  const evidence = path.join(directory, "fictional-evidence.txt");
  const testPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  await writeFile(evidence, testPdf);
  const globals = globalThis as typeof globalThis & {
    mixoraD1Database?: CatalogDatabase; mixoraMediaStore?: MediaStore; mixoraAgreementStore?: AgreementStore;
  };
  const oldDb = globals.mixoraD1Database;
  const oldStore = globals.mixoraMediaStore;
  const oldAgreementStore = globals.mixoraAgreementStore;
  const oldKey = process.env.MIXORA_AUDIT_HMAC_KEY;
  process.env.MIXORA_AUDIT_HMAC_KEY = "11".repeat(32);
  globals.mixoraD1Database = {
    query: async (sql: string, values: unknown[] = []) => {
      const params: (string | number | null)[] = [];
      const statement = sql.replace(/\$(\d+)/g, (_, index: string) => {
        params.push(values[Number(index) - 1] as string | number | null);
        return "?";
      });
      return { rows: database.prepare(statement).all(...params), changes: 0 };
    }, end: async () => undefined,
  } as CatalogDatabase;
  globals.mixoraMediaStore = {
    put: async () => undefined, get: async () => null, delete: async () => undefined,
    head: async () => ({ bytes: 100, mimeType: "audio/wav", sha256: audioHash }),
  };
  const documents = new Map<string, { bytes: Buffer; sha256: string; writeId: string }>();
  globals.mixoraAgreementStore = {
    put: async (key, bytes, sha256) => {
      documents.set(key, { bytes, sha256, writeId: key.slice(11, -4) });
    },
    delete: async (key) => { documents.delete(key); },
    head: async (key) => {
      const item = documents.get(key);
      return item ? { byteSize: item.bytes.length, sha256: item.sha256,
        writeId: item.writeId } : null;
    },
    get: async (key) => {
      const item = documents.get(key);
      return item ? { bytes: item.bytes, sha256: item.sha256, mimeType: "application/pdf" } : null;
    },
  };  try {
    for (const [subject, roles] of [
      [ids.submitter, ["PARTNER_REGISTRAR", "PARTNER_VERIFIER", "RIGHTS_REVIEWER"]],
      [ids.verifier, ["PARTNER_VERIFIER", "RIGHTS_REVIEWER"]],
      [ids.trackSubmitter, ["PARTNER_REGISTRAR", "RIGHTS_REVIEWER"]],
      [ids.reviewer, ["RIGHTS_REVIEWER"]],
      [ids.revoker, ["REVOKER"]],
    ] as const) {
      for (const role of roles) database.prepare(
        "INSERT INTO catalog_staff_roles (subject, role, granted_by) VALUES (?, ?, 'unit-test')")
        .run(subject, role);
    }
    const fixture = await staffFixture();
    const principal = async (subject: string, role: Parameters<typeof authorizeStaffToken>[1]) =>
      authorizeStaffToken(await fixture.sign({}, "5m", subject), role, { config, keys: fixture.keys });
    const registrar = await principal(ids.submitter, "PARTNER_REGISTRAR");
    const selfPartnerVerifier = await principal(ids.submitter, "PARTNER_VERIFIER");
    const verifier = await principal(ids.verifier, "PARTNER_VERIFIER");
    const selfTrackReviewer = await principal(ids.trackSubmitter, "RIGHTS_REVIEWER");
    const partnerVerifierReviewer = await principal(ids.verifier, "RIGHTS_REVIEWER");
    const partnerSubmitterReviewer = await principal(ids.submitter, "RIGHTS_REVIEWER");
    const reviewer = await principal(ids.reviewer, "RIGHTS_REVIEWER");
    const revoker = await principal(ids.revoker, "REVOKER");

    await assert.rejects(principal(ids.outsider, "RIGHTS_REVIEWER"),
      (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    await assert.rejects(registerPartner("artist:forged", "ARTIST", "Forged", {} as StaffPrincipal), StaffAccessError);
    await assert.rejects(rejectTrack(ids.reviewer, evidence, "No rights found", revoker), StaffAccessError);

    assert.equal(await registerPartner("artist:test", "ARTIST", "Test artist", registrar), true);
    const agreementId = await uploadAgreement({
      partnerId: "artist:test", agreementType: "ARTIST",
      grantor: "Fictional grantor", grantee: "Fictional grantee",
      distributionAllowed: true, offlineAllowed: true, mixAllowed: true,
      validFrom: "2025-01-01", validUntil: null,
    }, testPdf, createHash("sha256").update(testPdf).digest("hex"), registrar);
    assert.equal(await decideAgreement(agreementId, "VERIFIED", "Document reviewed", verifier), true);
    assert.equal(await verifyPartner("artist:test", agreementId, evidence,
      "Agreement reviewed", selfPartnerVerifier), false, "submitter cannot verify own partner");
    assert.equal(await verifyPartner("artist:test", agreementId, evidence,
      "Agreement reviewed", verifier), true);
    assert.equal(database.prepare("SELECT status FROM catalog_partners WHERE partner_id='artist:test'").get()?.status, "VERIFIED");

    const first = "77777777-7777-4777-8777-777777777777";
    const second = "88888888-8888-4888-8888-888888888888";
    addTrack(database, first, "first");
    addTrack(database, second, "second");
    assert.equal(await approveTrack(first, evidence, "Rights reviewed", selfTrackReviewer), false,
      "track submitter cannot approve own track");
    assert.equal(await approveTrack(first, evidence, "Rights reviewed", partnerVerifierReviewer), false,
      "partner verifier cannot approve related track");
    assert.equal(await approveTrack(first, evidence, "Rights reviewed", partnerSubmitterReviewer), false,
      "partner submitter cannot approve related track");
    assert.equal(await approveTrack(first, evidence, "Rights reviewed", reviewer), true);
    assert.equal(database.prepare("SELECT decision FROM catalog_rights_reviews WHERE track_id=?").get(first)?.decision,
      "APPROVED");
    database.prepare("UPDATE catalog_tracks SET published=1 WHERE id=?").run(first);

    assert.equal(await rejectTrack(second, evidence, "Rights evidence incomplete", reviewer), true);
    assert.equal(database.prepare("SELECT decision FROM catalog_review_events WHERE entity_id=?").get(second)?.decision,
      "REJECTED");
    assert.equal(database.prepare("SELECT decision FROM catalog_rights_reviews WHERE track_id=?").get(second)?.decision,
      "REVOKED", "legacy publication guard receives a blocking projection");
    assert.equal(await revokeReview("artist:test", "first", revoker,
      "Rights permission withdrawn", evidence), true);
    assert.equal(database.prepare("SELECT published FROM catalog_tracks WHERE id=?").get(first)?.published, 0);
    assert.throws(() => database.prepare("UPDATE catalog_tracks SET published=1 WHERE id=?").run(first),
      /review approval required/);

    assert.equal(await registerPartner("artist:rejected", "ARTIST", "Rejected test", registrar), true);
    assert.equal(await rejectPartner("artist:rejected", evidence, "Agreement missing", verifier), true);
    assert.equal(database.prepare("SELECT review_status FROM catalog_partners WHERE partner_id='artist:rejected'").get()?.review_status,
      "REJECTED");
    assert.equal(await revokePartner("artist:test", evidence, "Agreement withdrawn", revoker), true);
    assert.equal(database.prepare("SELECT status FROM catalog_partners WHERE partner_id='artist:test'").get()?.status,
      "SUSPENDED");

    const approvedEvent = database.prepare("SELECT actor_subject, metadata_version, audio_sha256, evidence_sha256, agreement_sha256, recorded_at, reason FROM catalog_review_events WHERE entity_id=? AND decision='APPROVED'").get(first);
    assert.equal(approvedEvent?.actor_subject, ids.reviewer);
    assert.equal(approvedEvent?.metadata_version, fingerprint);
    assert.equal(approvedEvent?.audio_sha256, audioHash);
    assert.match(String(approvedEvent?.evidence_sha256), /^[a-f0-9]{64}$/);
    assert.match(String(approvedEvent?.agreement_sha256), /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(String(approvedEvent?.recorded_at))));
    assert.equal(approvedEvent?.reason, "Rights reviewed");
    assert.throws(() => database.prepare(`INSERT INTO catalog_rights_reviews
      (track_id, decision, reviewer_id, evidence_sha256, import_fingerprint, audio_sha256, rights_evidence_ref)
      VALUES (?, 'APPROVED', ?, ?, ?, ?, 'test-evidence-ref')`).run(
      first, ids.outsider, "b".repeat(64), fingerprint, audioHash), /audit event required for review/);
    assert.equal(await verifyAuditHistory(), 6);
    assert.throws(() => database.prepare("UPDATE catalog_review_events SET reason='tampered' WHERE event_seq=1").run(),
      /audit history is immutable/);
    assert.throws(() => database.prepare("DELETE FROM catalog_rights_reviews WHERE track_id=?").run(first),
      /review history is immutable/);
    database.exec("DROP TRIGGER catalog_review_events_immutable_update");
    database.prepare("UPDATE catalog_review_events SET reason='tampered' WHERE event_seq=1").run();
    await assert.rejects(verifyAuditHistory(), /Audit history signature mismatch/);
  } finally {
    globals.mixoraD1Database = oldDb;
    globals.mixoraMediaStore = oldStore;
    globals.mixoraAgreementStore = oldAgreementStore;
    if (oldKey === undefined) delete process.env.MIXORA_AUDIT_HMAC_KEY;
    else process.env.MIXORA_AUDIT_HMAC_KEY = oldKey;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
