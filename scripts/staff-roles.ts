import "../lib/load-env";
import { hashEvidenceFile } from "../lib/audit";
import { db } from "../lib/db";
import { staffAdminFromEnvironment } from "../lib/staff-admin";
import { changeStaffRole } from "../lib/staff-role-audit";
import type { StaffRoleAction } from "../lib/staff-role-audit";
import { staffRoles } from "../lib/staff-auth";

async function main(): Promise<void> {
  const [command, target, role, expiry, evidenceFile, ...reasonParts] = process.argv.slice(2);
  const actions = { grant: "GRANTED", disable: "DISABLED", expiry: "EXPIRY_CHANGED" } as const;
  const action = actions[command as keyof typeof actions] as StaffRoleAction | undefined;
  if (!action || !target || !role || !staffRoles.includes(role as typeof staffRoles[number]) ||
      !expiry || !evidenceFile || !reasonParts.length) {
    throw new Error("Usage: pnpm staff:role <grant|disable|expiry> <subject-uuid> " +
      "<role> <UTC-expiry|none> <evidence-file> <reason>");
  }
  const admin = await staffAdminFromEnvironment();
  const changed = await changeStaffRole(action, target, role as typeof staffRoles[number],
    expiry === "none" ? null : expiry, await hashEvidenceFile(evidenceFile),
    reasonParts.join(" "), admin);
  if (!changed) throw new Error("Staff role change is not eligible; no event recorded");
  console.log("Staff role change recorded in the append-only audit");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Staff role change failed");
  process.exitCode = 1;
}).finally(() => db().end().catch(() => undefined));
