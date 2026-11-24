import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import { authorizeStaffAdminToken, requireStaffAdmin } from "../lib/staff-admin";
import { changeStaffRole, verifyStaffRoleAuditHistory } from "../lib/staff-role-audit";
import { StaffAccessError } from "../lib/staff-auth";
import { config, humanSubject, staffFixture } from "./staff-fixtures";

const target = "77777777-7777-4777-8777-777777777777";
const evidence = "a".repeat(64);

test("verified administrator role changes are atomic, authorized and append-only", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(await readFile(path.resolve("migrations/0003_staff_roles.sql"), "utf8"));
  sqlite.exec(await readFile(path.resolve("migrations/0006_staff_administration.sql"), "utf8"));
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };
  const previousDb = globals.mixoraD1Database;
  const previousKey = process.env.MIXORA_AUDIT_HMAC_KEY;
  process.env.MIXORA_AUDIT_HMAC_KEY = "33".repeat(32);
  globals.mixoraD1Database = {
    query: async (sql: string, values: unknown[] = []) => {
      const params: (string | number | null)[] = [];
      const statement = sql.replace(/\$(\d+)/g, (_, index: string) => {
        params.push(values[Number(index) - 1] as string | number | null);
        return "?";
      });
      const result = sqlite.prepare(statement);
      return { rows: result.all(...params), changes: 0 };
    },
    end: async () => undefined,
  } as CatalogDatabase;
  try {
    const fixture = await staffFixture();
    const jwt = await fixture.sign();
    await assert.rejects(authorizeStaffAdminToken("", { config, keys: fixture.keys }),
      (error: unknown) => error instanceof StaffAccessError && error.status === 401);
    await assert.rejects(authorizeStaffAdminToken(jwt, { config, keys: fixture.keys }),
      (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    sqlite.prepare("INSERT INTO catalog_staff_admins (subject,granted_by) VALUES (?,'trusted-bootstrap')")
      .run(humanSubject);
    const admin = await authorizeStaffAdminToken(jwt, { config, keys: fixture.keys });
    assert.equal(requireStaffAdmin(admin), humanSubject);
    await assert.rejects(changeStaffRole("GRANTED", target, "AUDITOR", null, evidence,
      "Attempted fake administrator", {} as typeof admin), StaffAccessError);
    await assert.rejects(changeStaffRole("GRANTED", humanSubject, "AUDITOR", null, evidence,
      "Self grant is forbidden", admin), /Invalid staff role change/);
    assert.equal(await changeStaffRole("GRANTED", target, "AUDITOR", null, evidence,
      "Scoped test grant", admin), true);
    assert.throws(() => sqlite.prepare(
      "INSERT INTO catalog_staff_roles (subject,role,granted_by) VALUES (?,'PUBLISHER','forged')")
      .run(target), /staff role audit event required/);
    assert.throws(() => sqlite.prepare(
      "UPDATE catalog_staff_roles SET enabled=0 WHERE subject=? AND role='AUDITOR'")
      .run(target), /staff role audit event required/);
    assert.equal(sqlite.prepare("SELECT enabled FROM catalog_staff_roles WHERE subject=? AND role='AUDITOR'")
      .get(target)?.enabled, 1);
    assert.equal(await changeStaffRole("DISABLED", target, "AUDITOR", null, evidence,
      "Test role removal", admin), true);
    assert.equal(sqlite.prepare("SELECT enabled FROM catalog_staff_roles WHERE subject=? AND role='AUDITOR'")
      .get(target)?.enabled, 0);
    assert.equal(await changeStaffRole("GRANTED", target, "AUDITOR", null, evidence,
      "Restore test grant", admin), true);
    const expiry = "2030-01-01T00:00:00.000Z";
    assert.equal(await changeStaffRole("EXPIRY_CHANGED", target, "AUDITOR", expiry, evidence,
      "Set test expiry", admin), true);
    assert.equal(sqlite.prepare("SELECT expires_at FROM catalog_staff_roles WHERE subject=? AND role='AUDITOR'")
      .get(target)?.expires_at, expiry);
    assert.equal(await verifyStaffRoleAuditHistory(), 4);
    assert.throws(() => sqlite.prepare(
      "UPDATE catalog_staff_role_events SET reason='tampered' WHERE event_seq=1").run(),
      /staff role audit is immutable/);
    assert.throws(() => sqlite.prepare(
      "DELETE FROM catalog_staff_roles WHERE subject=? AND role='AUDITOR'").run(target),
      /staff role history is retained/);
    sqlite.prepare("UPDATE catalog_staff_admins SET enabled=0 WHERE subject=?").run(humanSubject);
    await assert.rejects(authorizeStaffAdminToken(jwt, { config, keys: fixture.keys }),
      (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    await assert.rejects(changeStaffRole("DISABLED", target, "AUDITOR", null, evidence,
      "Admin revoked mid-operation", admin), /active staff administrator required/);
    assert.equal(await verifyStaffRoleAuditHistory(), 4);
  } finally {
    globals.mixoraD1Database = previousDb;
    if (previousKey === undefined) delete process.env.MIXORA_AUDIT_HMAC_KEY;
    else process.env.MIXORA_AUDIT_HMAC_KEY = previousKey;
    sqlite.close();
  }
});
