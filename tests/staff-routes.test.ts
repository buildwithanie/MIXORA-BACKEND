import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogDatabase } from "../lib/db";
import { GET as inspect } from "../app/api/staff/agreements/[id]/route";
import { GET as retrieve } from "../app/api/staff/agreements/[id]/file/route";
import { POST as upload } from "../app/api/staff/agreements/route";
import { POST as decide } from "../app/api/staff/agreements/[id]/decision/route";
import { config, humanSubject, staffFixture } from "./staff-fixtures";

const id = "00000000-0000-4000-8000-000000000001";
const roles = ["PARTNER_REGISTRAR", "PARTNER_VERIFIER", "RIGHTS_REVIEWER",
  "PUBLISHER", "REVOKER", "AUDITOR"] as const;
const routes = [
  { name: "upload", method: "POST", url: "/api/staff/agreements",
    allowed: ["PARTNER_REGISTRAR"], call: (request: Request) => upload(request) },
  { name: "inspect", method: "GET", url: "/api/staff/agreements/" + id,
    allowed: ["PARTNER_VERIFIER", "AUDITOR"],
    call: (request: Request) => inspect(request, { params: Promise.resolve({ id }) }) },
  { name: "retrieve", method: "GET", url: "/api/staff/agreements/" + id + "/file",
    allowed: ["PARTNER_VERIFIER", "AUDITOR"],
    call: (request: Request) => retrieve(request, { params: Promise.resolve({ id }) }) },
  { name: "decide", method: "POST", url: "/api/staff/agreements/" + id + "/decision",
    allowed: ["PARTNER_VERIFIER", "REVOKER"],
    call: (request: Request) => decide(request, { params: Promise.resolve({ id }) }) },
] as const;

test("every staff route rejects bad JWTs and every insufficient role", async () => {
  const fixture = await staffFixture();
  const previousFetch = globalThis.fetch;
  const previousIssuer = process.env.CF_ACCESS_TEAM_DOMAIN;
  const previousAudience = process.env.CF_ACCESS_AUD;
  const globals = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };
  const previousDb = globals.mixoraD1Database;
  let activeRoles: readonly string[] = [];
  let lookups = 0;
  process.env.CF_ACCESS_TEAM_DOMAIN = config.issuer;
  process.env.CF_ACCESS_AUD = config.audience;
  globalThis.fetch = async () => Response.json({ keys: [fixture.jwk] });
  globals.mixoraD1Database = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("catalog_staff_roles")) {
        lookups++;
        assert.equal(values[0], humanSubject);
        return { rows: activeRoles.map((role) => ({ role })), changes: 0 };
      }
      return { rows: [], changes: 0 };
    },
    end: async () => undefined,
  } as CatalogDatabase;
  const request = (route: typeof routes[number], token?: string) => new Request(
    "https://backend.example.test" + route.url, {
      method: route.method, headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
    });
  try {
    const valid = await fixture.sign();
    const parts = valid.split(".");
    const badSignature = parts[0] + "." + parts[1] + "." +
      (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    const invalid = [
      ["missing", undefined],
      ["malformed", "not-a-jwt"],
      ["signature", badSignature],
      ["issuer", await fixture.sign({}, "5m", humanSubject,
        { issuer: "https://other.cloudflareaccess.com" })],
      ["audience", await fixture.sign({}, "5m", humanSubject,
        { audience: "b".repeat(64) })],
      ["expired", await fixture.sign({}, Math.floor(Date.now() / 1000) - 300)],
      ["service", await fixture.sign({ common_name: "service-token" })],
    ] as const;
    for (const route of routes) {
      for (const [kind, token] of invalid) {
        const response = await route.call(request(route, token));
        assert.equal(response.status, 401, route.name + " must reject " + kind);
      }
    }
    assert.equal(lookups, 0, "invalid JWTs must never query staff roles");
    for (const route of routes) {
      for (const role of roles) {
        activeRoles = [role];
        const response = await route.call(request(route, valid));
        if (route.allowed.includes(role as never)) {
          assert.notEqual(response.status, 401, route.name + " should authenticate " + role);
          assert.notEqual(response.status, 403, route.name + " should authorize " + role);
        } else {
          assert.equal(response.status, 403, route.name + " must deny " + role);
        }
      }
    }
  } finally {
    globals.mixoraD1Database = previousDb;
    globalThis.fetch = previousFetch;
    if (previousIssuer === undefined) delete process.env.CF_ACCESS_TEAM_DOMAIN;
    else process.env.CF_ACCESS_TEAM_DOMAIN = previousIssuer;
    if (previousAudience === undefined) delete process.env.CF_ACCESS_AUD;
    else process.env.CF_ACCESS_AUD = previousAudience;
  }
});
