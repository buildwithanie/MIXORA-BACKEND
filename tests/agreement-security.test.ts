import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import type { AgreementStore } from "../lib/agreement-store";
import { AgreementError, decideAgreement, inspectAgreement, retrieveAgreement, uploadAgreement } from "../lib/agreements";
import type { AgreementInput } from "../lib/agreements";
import { verifyAgreementAuditHistory } from "../lib/agreement-audit";
import { authorizeStaffToken, StaffAccessError } from "../lib/staff-auth";
import type { StaffPrincipal } from "../lib/staff-auth";
import { GET as metadataGet } from "../app/api/staff/agreements/[id]/route";
import { GET as fileGet } from "../app/api/staff/agreements/[id]/file/route";
import { POST as uploadPost } from "../app/api/staff/agreements/route";
import { POST as decisionPost } from "../app/api/staff/agreements/[id]/decision/route";
import { GET as publicMediaGet } from "../app/api/media/[id]/route";
import { config, staffFixture } from "./staff-fixtures";

const ids = {
  registrar: "11111111-1111-4111-8111-111111111111",
  verifier: "22222222-2222-4222-8222-222222222222",
  auditor: "33333333-3333-4333-8333-333333333333",
  revoker: "44444444-4444-4444-8444-444444444444",
  outsider: "55555555-5555-4555-8555-555555555555",
  registrarOnly: "66666666-6666-4666-8666-666666666666",
};
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const sha = createHash("sha256").update(pdf).digest("hex");
const input: AgreementInput = {
  partnerId: "artist:private-test", agreementType: "ARTIST",
  grantor: "Fictional rights party", grantee: "Fictional MIXORA party",
  distributionAllowed: true, offlineAllowed: true, mixAllowed: true,
  validFrom: "2025-01-01", validUntil: null,
};

test("private agreements enforce staff identity, checksums, role separation and immutable audit", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["schema.sql", "migrations/0002_partner_review.sql",
    "migrations/0003_staff_roles.sql", "migrations/0004_review_audit.sql",
    "migrations/0005_protected_agreements.sql"]) {
    sqlite.exec(await readFile(path.resolve(file), "utf8"));
  }
  const globals = globalThis as typeof globalThis & {
    mixoraD1Database?: CatalogDatabase; mixoraAgreementStore?: AgreementStore;
  };
  const previousDb = globals.mixoraD1Database;
  const previousStore = globals.mixoraAgreementStore;
  const previousKey = process.env.MIXORA_AUDIT_HMAC_KEY;
  const previousIssuer = process.env.CF_ACCESS_TEAM_DOMAIN;
  const previousAud = process.env.CF_ACCESS_AUD;
  process.env.MIXORA_AUDIT_HMAC_KEY = "22".repeat(32);
  process.env.CF_ACCESS_TEAM_DOMAIN = config.issuer;
  process.env.CF_ACCESS_AUD = config.audience;
  globals.mixoraD1Database = {
    query: async (sql: string, values: unknown[] = []) => {
      const params: (string | number | null)[] = [];
      const statement = sql.replace(/\$(\d+)/g, (_, index: string) => {
        params.push(values[Number(index) - 1] as string | number | null);
        return "?";
      });
      return { rows: sqlite.prepare(statement).all(...params), changes: 0 };
    },
    end: async () => undefined,
  } as CatalogDatabase;
  const documents = new Map<string, { bytes: Buffer; sha256: string; writeId: string }>();
  globals.mixoraAgreementStore = {
    put: async (key, bytes, checksum) => {
      documents.set(key, { bytes, sha256: checksum, writeId: key.slice(11, -4) });
    },
    delete: async (key) => { documents.delete(key); },
    head: async (key) => {
      const item = documents.get(key);
      return item ? { byteSize: item.bytes.length, sha256: item.sha256,
        writeId: item.writeId } : null;
    },
    get: async (key) => {
      const item = documents.get(key);
      return item ? { bytes: item.bytes, mimeType: "application/pdf", sha256: item.sha256 } : null;
    },
  };
  try {
    sqlite.prepare("INSERT INTO catalog_partners (partner_id, kind, display_name) VALUES (?,?,?)")
      .run(input.partnerId, "ARTIST", "Fictional artist");
    for (const [subject, roles] of [
      [ids.registrar, ["PARTNER_REGISTRAR", "PARTNER_VERIFIER"]],
      [ids.verifier, ["PARTNER_VERIFIER"]],
      [ids.auditor, ["AUDITOR"]],
      [ids.revoker, ["REVOKER"]],
      [ids.registrarOnly, ["PARTNER_REGISTRAR"]],
    ] as const) {
      for (const staffRole of roles) sqlite.prepare(
        "INSERT INTO catalog_staff_roles (subject, role, granted_by) VALUES (?, ?, 'test')")
        .run(subject, staffRole);
    }
    const fixture = await staffFixture();
    const principal = async (subject: string, staffRole: Parameters<typeof authorizeStaffToken>[1]) =>
      authorizeStaffToken(await fixture.sign({}, "5m", subject), staffRole,
        { config, keys: fixture.keys });
    const registrar = await principal(ids.registrar, "PARTNER_REGISTRAR");
    const selfVerifier = await principal(ids.registrar, "PARTNER_VERIFIER");
    const registrarOnly = await principal(ids.registrarOnly, "PARTNER_REGISTRAR");
    const verifier = await principal(ids.verifier, "PARTNER_VERIFIER");
    const auditor = await principal(ids.auditor, "AUDITOR");
    const revoker = await principal(ids.revoker, "REVOKER");

    const context = { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) };
    assert.equal((await metadataGet(new Request("http://test/api/staff/agreements/" + (await context.params).id),
      context)).status, 401);
    assert.equal((await fileGet(new Request("http://test/api/staff/agreements/" + (await context.params).id + "/file"),
      context)).status, 401);
    assert.equal((await uploadPost(new Request("http://test/api/staff/agreements", { method: "POST" }))).status, 401);
    assert.equal((await decisionPost(new Request("http://test/api/staff/agreements/" + (await context.params).id +
      "/decision", { method: "POST" }), context)).status, 401);
    await assert.rejects(principal(ids.outsider, "PARTNER_VERIFIER"),
      (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    await assert.rejects(uploadAgreement(input, pdf, sha, {} as StaffPrincipal), StaffAccessError);
    await assert.rejects(uploadAgreement(input, pdf, sha, auditor), StaffAccessError);
    await assert.rejects(uploadAgreement(input, Buffer.from("not a PDF"), sha, registrar),
      (error: unknown) => error instanceof AgreementError && error.status === 400);
    await assert.rejects(uploadAgreement(input, pdf, "0".repeat(64), registrar),
      (error: unknown) => error instanceof AgreementError && error.status === 400);
    assert.equal(documents.size, 0);

    const id = await uploadAgreement(input, pdf, sha, registrar);
    const stored = sqlite.prepare("SELECT object_key, sha256, verification_status, distribution_allowed " +
      "FROM catalog_agreements WHERE agreement_id=?").get(id);
    assert.equal(stored?.sha256, sha);
    assert.equal(stored?.verification_status, "PENDING");
    assert.equal(stored?.distribution_allowed, 1);
    assert.match(String(stored?.object_key), /^agreements\/[a-f0-9-]+\.pdf$/);
    const initialObjectCount = documents.size;
    const originalPut = globals.mixoraAgreementStore.put;
    globals.mixoraAgreementStore.put = async (key, bytes, checksum) => {
      await originalPut(key, bytes, checksum);
      sqlite.prepare("UPDATE catalog_staff_roles SET enabled=0 WHERE subject=? AND role='PARTNER_REGISTRAR'")
        .run(ids.registrar);
    };
    await assert.rejects(uploadAgreement(input, pdf, sha, registrar), /active staff role required/);
    assert.equal(documents.size, initialObjectCount, "revoked uploader must leave no unaudited R2 object");
    globals.mixoraAgreementStore.put = originalPut;
    sqlite.prepare("UPDATE catalog_staff_roles SET enabled=1 WHERE subject=? AND role='PARTNER_REGISTRAR'")
      .run(ids.registrar);
    const realDb = globals.mixoraD1Database;
    globals.mixoraD1Database = {
      ...realDb,
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith("INSERT INTO catalog_agreement_events")) throw new Error("simulated audit outage");
        return realDb.query(sql, values);
      },
    };
    await assert.rejects(uploadAgreement(input, pdf, sha, registrar), /simulated audit outage/);
    assert.equal(documents.size, initialObjectCount, "failed audit must leave no unaudited R2 object");
    globals.mixoraD1Database = realDb;
    globals.mixoraAgreementStore.put = async (key, bytes, checksum) => {
      await originalPut(key, bytes, checksum);
      throw new Error("simulated upload response loss");
    };
    await assert.rejects(uploadAgreement(input, pdf, sha, registrar), /simulated upload response loss/);
    assert.equal(documents.size, initialObjectCount, "ambiguous committed write must be compensated");
    let collisionKey = "";
    globals.mixoraAgreementStore.put = async (key, bytes, checksum) => {
      collisionKey = key;
      documents.set(key, { bytes, sha256: checksum, writeId: "another-request" });
      throw new Error("simulated create-only conflict");
    };
    await assert.rejects(uploadAgreement(input, pdf, sha, registrar), /simulated create-only conflict/);
    assert.equal(documents.has(collisionKey), true, "compensation must preserve an existing object");
    documents.delete(collisionKey);
    globals.mixoraAgreementStore.put = originalPut;
    await assert.rejects(retrieveAgreement(id, registrarOnly), StaffAccessError);
    assert.equal((await inspectAgreement(id, verifier))?.agreement_id, id);
    assert.deepEqual(await retrieveAgreement(id, auditor), pdf);
    const doc = documents.get(String(stored?.object_key))!;
    documents.set(String(stored?.object_key), { ...doc, bytes: Buffer.from("tampered") });
    await assert.rejects(retrieveAgreement(id, verifier),
      (error: unknown) => error instanceof AgreementError && error.status === 503);
    documents.set(String(stored?.object_key), doc);
    assert.equal(await decideAgreement(id, "VERIFIED", "Checked document", selfVerifier), false);
    assert.equal(await decideAgreement(id, "VERIFIED", "Checked document", verifier), true);
    assert.equal(sqlite.prepare("SELECT verification_status FROM catalog_agreements WHERE agreement_id=?")
      .get(id)?.verification_status, "VERIFIED");
    await assert.rejects(decideAgreement(id, "REJECTED", "Auditor cannot decide", auditor), StaffAccessError);
    const secondId = await uploadAgreement(input, pdf, sha, registrar);
    assert.equal(await decideAgreement(secondId, "REJECTED", "Agreement terms incomplete", verifier), true);
    assert.equal(sqlite.prepare("SELECT verification_status FROM catalog_agreements WHERE agreement_id=?")
      .get(secondId)?.verification_status, "REJECTED");
    assert.equal((await publicMediaGet(new Request("http://test/api/media/" + secondId),
      { params: Promise.resolve({ id: secondId }) })).status, 404);    assert.equal(await decideAgreement(id, "REVOKED", "Rights withdrawn", revoker), true);
    assert.equal(sqlite.prepare("SELECT verification_status FROM catalog_agreements WHERE agreement_id=?")
      .get(id)?.verification_status, "REVOKED");
    assert.equal(await verifyAgreementAuditHistory(), 7);
    assert.throws(() => sqlite.prepare("UPDATE catalog_agreement_events SET reason='tampered' WHERE event_seq=1").run(),
      /agreement audit is immutable/);
    assert.throws(() => sqlite.prepare("DELETE FROM catalog_agreements WHERE agreement_id=?").run(id),
      /agreement records are retained/);
    assert.throws(() => sqlite.prepare("UPDATE catalog_agreements SET verification_status='VERIFIED' WHERE agreement_id=?")
      .run(id), /agreement decision audit required/);
    sqlite.exec("DROP TRIGGER catalog_agreements_metadata_guard");
    sqlite.prepare("UPDATE catalog_agreements SET mix_allowed=0 WHERE agreement_id=?").run(id);
    await assert.rejects(inspectAgreement(id, verifier), /metadata integrity check failed/);
    await assert.rejects(verifyAgreementAuditHistory(), /metadata snapshot mismatch/);
    sqlite.prepare("UPDATE catalog_agreements SET mix_allowed=1 WHERE agreement_id=?").run(id);    sqlite.exec("DROP TRIGGER catalog_agreement_events_immutable_update");
    sqlite.prepare("UPDATE catalog_agreement_events SET reason='tampered' WHERE event_seq=1").run();
    await assert.rejects(verifyAgreementAuditHistory(), /Agreement audit signature mismatch/);
  } finally {
    globals.mixoraD1Database = previousDb;
    globals.mixoraAgreementStore = previousStore;
    if (previousKey === undefined) delete process.env.MIXORA_AUDIT_HMAC_KEY;
    else process.env.MIXORA_AUDIT_HMAC_KEY = previousKey;
    if (previousIssuer === undefined) delete process.env.CF_ACCESS_TEAM_DOMAIN;
    else process.env.CF_ACCESS_TEAM_DOMAIN = previousIssuer;
    if (previousAud === undefined) delete process.env.CF_ACCESS_AUD;
    else process.env.CF_ACCESS_AUD = previousAud;
    sqlite.close();
  }
});




