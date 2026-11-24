import "../lib/load-env";
import { db } from "../lib/db";
import { requireStaffRole, staffFromEnvironment, staffRoles, StaffAccessError } from "../lib/staff-auth";

async function main(): Promise<void> {
  const principal = await staffFromEnvironment("PARTNER_REGISTRAR");
  requireStaffRole(principal, "PARTNER_REGISTRAR");
  for (const role of staffRoles) {
    if (role === "PARTNER_REGISTRAR") continue;
    try {
      requireStaffRole(principal, role);
    } catch (error) {
      if (error instanceof StaffAccessError && error.status === 403) continue;
      throw error;
    }
    throw new Error("Unexpected additional staff role");
  }
  console.log("Access JWT verified; subject has an active PARTNER_REGISTRAR grant and no other active roles.");
}

main().catch((error: unknown) => {
  console.error(error instanceof StaffAccessError ? error.message : "Staff verification failed");
  process.exitCode = 1;
}).finally(() => db().end().catch(() => undefined));