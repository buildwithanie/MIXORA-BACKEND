import type { JWTVerifyGetKey } from "jose";
import { db } from "./db";
import { accessConfig, StaffAccessError, verifyStaffJwt } from "./staff-auth";
import type { AccessConfig } from "./staff-auth";

const adminBrand = Symbol("MIXORA verified staff administrator");
export type StaffAdminPrincipal = Readonly<{
  subject: string; email: string; [adminBrand]: true;
}>;

export async function authorizeStaffAdminToken(token: string,
  options?: { config: AccessConfig; keys: JWTVerifyGetKey }): Promise<StaffAdminPrincipal> {
  const identity = await verifyStaffJwt(token, options?.config ?? accessConfig(), options?.keys);
  const result = await db().query<{ subject: string }>(
    "SELECT subject FROM catalog_staff_admins WHERE subject=$1 AND enabled=1 " +
      "AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))", [identity.subject]);
  if (!result.rows.length) throw new StaffAccessError("Staff administrator required", 403);
  return Object.freeze({ ...identity, [adminBrand]: true as const });
}

export async function staffAdminFromEnvironment(): Promise<StaffAdminPrincipal> {
  return authorizeStaffAdminToken(process.env.CF_ACCESS_JWT ?? "");
}

export function requireStaffAdmin(principal: StaffAdminPrincipal): string {
  if (!principal || principal[adminBrand] !== true) {
    throw new StaffAccessError("Staff administrator required", 403);
  }
  return principal.subject;
}
