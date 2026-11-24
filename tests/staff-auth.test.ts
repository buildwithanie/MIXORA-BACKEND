import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CatalogDatabase } from "../lib/db";
import { approveTrack } from "../lib/approvals";
import { publishTrack } from "../scripts/publish";
import { accessConfig, authorizeStaffRequest, authorizeStaffToken, requireStaffRole, StaffAccessError, verifyStaffJwt } from "../lib/staff-auth";
import type { StaffPrincipal } from "../lib/staff-auth";
import { config, humanSubject, staffFixture } from "./staff-fixtures";

test("Access JWT signature, issuer, audience and expiry are verified before D1 role lookup", async () => {
  const fixture = await staffFixture();
  const valid = await fixture.sign();
  assert.equal((await verifyStaffJwt(valid, config, fixture.keys)).subject, humanSubject);
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };
  const previous = globals.mixoraD1Database;
  let queries = 0;
  globals.mixoraD1Database = { query: async (sql: string, values?: unknown[]) => {
    queries++;
    assert.match(sql, /catalog_staff_roles/);
    assert.equal(values?.[0], humanSubject);
    return { rows: [{ role: "RIGHTS_REVIEWER" }], changes: 0 };
  }, end: async () => undefined } as CatalogDatabase;
  try {
    const principal = await authorizeStaffToken(valid, "RIGHTS_REVIEWER", { config, keys: fixture.keys });
    assert.equal(requireStaffRole(principal, "RIGHTS_REVIEWER"), humanSubject);
    assert.throws(() => requireStaffRole(principal, "PUBLISHER"), StaffAccessError);
    await assert.rejects(publishTrack(humanSubject, principal),
      (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    await assert.rejects(approveTrack(humanSubject, "unused-evidence", "Unit-test reason", {} as StaffPrincipal),
      (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    assert.throws(() => requireStaffRole({ subject: humanSubject, roles: new Set(["PUBLISHER"]) } as unknown as StaffPrincipal, "PUBLISHER"), StaffAccessError);
    assert.equal(queries, 1);
    const signatureStart = valid.lastIndexOf(".") + 1;
    const invalid = [
      valid.slice(0, signatureStart) + (valid[signatureStart] === "A" ? "B" : "A") + valid.slice(signatureStart + 1),
      await fixture.sign({ common_name: "service-token" }),
    ];
    for (const token of invalid) await assert.rejects(verifyStaffJwt(token, config, fixture.keys), StaffAccessError);
    await assert.rejects(verifyStaffJwt(valid, { ...config, issuer: "https://other.cloudflareaccess.com" }, fixture.keys), StaffAccessError);
    await assert.rejects(verifyStaffJwt(valid, { ...config, audience: "b".repeat(64) }, fixture.keys), StaffAccessError);
    const expired = await fixture.sign({}, Math.floor(Date.now() / 1000) - 300);
    await assert.rejects(verifyStaffJwt(expired, config, fixture.keys), StaffAccessError);
    assert.equal(queries, 1, "invalid identities must not reach role lookup");
  } finally { globals.mixoraD1Database = previous; }
});

test("service identities, missing roles and missing Access configuration fail closed", async () => {
  const fixture = await staffFixture();
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };
  const previous = globals.mixoraD1Database;
  globals.mixoraD1Database = { query: async () => ({ rows: [], changes: 0 }), end: async () => undefined } as CatalogDatabase;
  try {
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "service-key"; jwk.alg = "RS256"; jwk.use = "sig";
    const serviceToken = await new SignJWT({ type: "app", common_name: "service-token" })
      .setProtectedHeader({ alg: "RS256", kid: "service-key" })
      .setIssuer(config.issuer).setAudience(config.audience).setSubject("")
      .setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    await assert.rejects(verifyStaffJwt(serviceToken, config, createLocalJWKSet({ keys: [jwk] })), StaffAccessError);
    await assert.rejects(authorizeStaffToken(await fixture.sign(), "PUBLISHER", { config, keys: fixture.keys }),
      (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    await assert.rejects(verifyStaffJwt("", config, fixture.keys), StaffAccessError);
    const oldDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
    const oldAudience = process.env.CF_ACCESS_AUD;
    try {
      delete process.env.CF_ACCESS_TEAM_DOMAIN;
      delete process.env.CF_ACCESS_AUD;
      assert.throws(accessConfig, (error: unknown) => error instanceof StaffAccessError && error.status === 503);
    } finally {
      if (oldDomain === undefined) delete process.env.CF_ACCESS_TEAM_DOMAIN;
      else process.env.CF_ACCESS_TEAM_DOMAIN = oldDomain;
      if (oldAudience === undefined) delete process.env.CF_ACCESS_AUD;
      else process.env.CF_ACCESS_AUD = oldAudience;
    }
  } finally { globals.mixoraD1Database = previous; }
});

test("disabled and expired D1 grants cannot authorize staff actions", async () => {
  const fixture = await staffFixture();
  const token = await fixture.sign();
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(path.resolve("migrations/0003_staff_roles.sql"), "utf8"));
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };
  const previous = globals.mixoraD1Database;
  globals.mixoraD1Database = { query: async (sql: string, values: unknown[] = []) => ({
    rows: database.prepare(sql.replace(/\$\d+/g, "?")).all(...values as string[]), changes: 0,
  }), end: async () => undefined } as CatalogDatabase;
  const authorize = () => authorizeStaffToken(token, "RIGHTS_REVIEWER", { config, keys: fixture.keys });
  try {
    database.prepare("INSERT INTO catalog_staff_roles (subject, role, enabled, granted_by) VALUES (?, 'RIGHTS_REVIEWER', 0, 'unit-test')")
      .run(humanSubject);
    await assert.rejects(authorize(), (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    database.prepare("UPDATE catalog_staff_roles SET enabled=1, expires_at='2000-01-01T00:00:00Z'").run();
    await assert.rejects(authorize(), (error: unknown) => error instanceof StaffAccessError && error.status === 403);
    database.prepare("UPDATE catalog_staff_roles SET expires_at=NULL").run();
    assert.equal(requireStaffRole(await authorize(), "RIGHTS_REVIEWER"), humanSubject);
    const oldDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
    const oldAudience = process.env.CF_ACCESS_AUD;
    try {
      process.env.CF_ACCESS_TEAM_DOMAIN = config.issuer;
      process.env.CF_ACCESS_AUD = config.audience;
      await assert.rejects(authorizeStaffRequest(new Request("https://example.test"), "RIGHTS_REVIEWER"),
        (error: unknown) => error instanceof StaffAccessError && error.status === 401);
    } finally {
      if (oldDomain === undefined) delete process.env.CF_ACCESS_TEAM_DOMAIN;
      else process.env.CF_ACCESS_TEAM_DOMAIN = oldDomain;
      if (oldAudience === undefined) delete process.env.CF_ACCESS_AUD;
      else process.env.CF_ACCESS_AUD = oldAudience;
    }
  } finally {
    globals.mixoraD1Database = previous;
    database.close();
  }
});
