import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { db } from "./db";

export const staffRoles = ["PARTNER_REGISTRAR", "PARTNER_VERIFIER", "RIGHTS_REVIEWER", "PUBLISHER", "REVOKER", "AUDITOR"] as const;
export type StaffRole = typeof staffRoles[number];
export type AccessConfig = { issuer: string; audience: string };
const staffBrand = Symbol("MIXORA verified staff");
export type StaffPrincipal = Readonly<{ subject: string; email: string; roles: readonly StaffRole[]; [staffBrand]: true }>;

export class StaffAccessError extends Error {
  constructor(message: string, public readonly status: 401 | 403 | 503) { super(message); this.name = "StaffAccessError"; }
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function accessConfig(): AccessConfig {
  const issuer = process.env.CF_ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, "");
  const audience = process.env.CF_ACCESS_AUD?.trim();
  if (!issuer || !audience) throw new StaffAccessError("Cloudflare Access is not configured", 503);
  let url: URL;
  try { url = new URL(issuer); } catch { throw new StaffAccessError("Invalid Cloudflare Access configuration", 503); }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9]{32,128}$/i.test(audience)) {
    throw new StaffAccessError("Invalid Cloudflare Access configuration", 503);
  }
  return { issuer: url.origin, audience };
}

function remoteKeys(issuer: string): JWTVerifyGetKey {
  let keys = jwksCache.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`),
      { [customFetch]: (...args) => globalThis.fetch(...args) });
    jwksCache.set(issuer, keys);
  }
  return keys;
}

export async function verifyStaffJwt(token: string, config: AccessConfig = accessConfig(), keys?: JWTVerifyGetKey) {
  if (!token || token.length > 16_384) throw new StaffAccessError("Cloudflare Access token required", 401);
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, keys ?? remoteKeys(config.issuer), {
      issuer: config.issuer, audience: config.audience, algorithms: ["RS256"], clockTolerance: "5s",
    }));
  } catch {
    throw new StaffAccessError("Invalid Cloudflare Access token", 401);
  }
  if (payload.type !== "app" || !uuid.test(payload.sub ?? "") ||
      typeof payload.email !== "string" || !payload.email.includes("@") ||
      typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000) ||
      payload.common_name !== undefined) {
    throw new StaffAccessError("Human Cloudflare Access identity required", 401);
  }
  return { subject: payload.sub!, email: payload.email };
}

export async function authorizeStaffToken(token: string, requiredRole: StaffRole,
  options?: { config: AccessConfig; keys: JWTVerifyGetKey }): Promise<StaffPrincipal> {
  return authorizeStaffTokenAny(token, [requiredRole], options);
}

export async function authorizeStaffTokenAny(token: string, allowedRoles: readonly StaffRole[],
  options?: { config: AccessConfig; keys: JWTVerifyGetKey }): Promise<StaffPrincipal> {
  if (allowedRoles.length === 0 || allowedRoles.some((role) => !staffRoles.includes(role))) {
    throw new StaffAccessError("Staff role required", 403);
  }
  const identity = await verifyStaffJwt(token, options?.config ?? accessConfig(), options?.keys);
  const result = await db().query<{ role: StaffRole }>(`
    SELECT role FROM catalog_staff_roles WHERE subject=$1 AND enabled=1
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`, [identity.subject]);
  const roles = new Set(result.rows.map((row) => row.role).filter((role) => staffRoles.includes(role)));
  if (!allowedRoles.some((role) => roles.has(role))) throw new StaffAccessError("Staff role required", 403);
  return Object.freeze({ ...identity, roles: Object.freeze([...roles]), [staffBrand]: true as const });
}

export async function authorizeStaffRequest(request: Request, requiredRole: StaffRole): Promise<StaffPrincipal> {
  return authorizeStaffToken(request.headers.get("Cf-Access-Jwt-Assertion") ?? "", requiredRole);
}

export async function authorizeStaffRequestAny(request: Request, allowedRoles: readonly StaffRole[]): Promise<StaffPrincipal> {
  return authorizeStaffTokenAny(request.headers.get("Cf-Access-Jwt-Assertion") ?? "", allowedRoles);
}
export async function staffFromEnvironment(requiredRole: StaffRole): Promise<StaffPrincipal> {
  return authorizeStaffToken(process.env.CF_ACCESS_JWT ?? "", requiredRole);
}

export function requireStaffRole(principal: StaffPrincipal, role: StaffRole): string {
  if (!principal || principal[staffBrand] !== true || !principal.roles.includes(role)) {
    throw new StaffAccessError("Staff role required", 403);
  }
  return principal.subject;
}

