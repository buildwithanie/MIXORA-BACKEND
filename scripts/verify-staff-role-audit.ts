import "../lib/load-env";
import { db } from "../lib/db";
import { verifyStaffRoleAuditHistory } from "../lib/staff-role-audit";

verifyStaffRoleAuditHistory()
  .then((count) => console.log("Staff role audit verified: " + count + " events"))
  .catch(() => { console.error("Staff role audit verification failed"); process.exitCode = 1; })
  .finally(() => db().end().catch(() => undefined));
