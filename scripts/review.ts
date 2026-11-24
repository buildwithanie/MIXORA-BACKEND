import "../lib/load-env";
import { approveTrack, rejectTrack } from "../lib/approvals";
import { staffFromEnvironment } from "../lib/staff-auth";

const [action, id, evidenceFile, reason] = process.argv.slice(2);
if (!["approve", "reject"].includes(action ?? "") || !id || !evidenceFile || !reason) {
  console.error("Usage: pnpm catalog:review <track-uuid> <evidence-file> <reason> or " +
    "pnpm catalog:reject <track-uuid> <evidence-file> <reason>");
  process.exitCode = 1;
} else {
  staffFromEnvironment("RIGHTS_REVIEWER")
    .then((staff) => action === "approve"
      ? approveTrack(id, evidenceFile, reason, staff)
      : rejectTrack(id, evidenceFile, reason, staff))
    .then((recorded) => {
      console.log(recorded ? `Track ${action} decision recorded in audit history` : "Track ineligible; no decision recorded");
      if (!recorded) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Review failed");
      process.exitCode = 1;
    });
}