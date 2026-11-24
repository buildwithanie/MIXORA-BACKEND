import "../lib/load-env";
import { registerPartner, verifyPartner, rejectPartner, revokePartner } from "../lib/approvals";
import { staffFromEnvironment } from "../lib/staff-auth";

async function main(): Promise<void> {
  const [, , action, ...args] = process.argv;
  if (action === "register" && args.length === 3) {
    const staff = await staffFromEnvironment("PARTNER_REGISTRAR");
    const created = await registerPartner(args[0], args[1], args[2], staff);
    console.log(created ? "Partner registered pending agreement verification" : "Partner already exists; no changes made");
  } else if (action === "verify" && args.length === 4) {
    const staff = await staffFromEnvironment("PARTNER_VERIFIER");
    const verified = await verifyPartner(args[0], args[1], args[2], args[3], staff);
    if (!verified) throw new Error("Partner ineligible for approval; no changes made");
    console.log("Partner approval and agreement evidence recorded in audit history");
  } else if (action === "reject" && args.length === 3) {
    const staff = await staffFromEnvironment("PARTNER_VERIFIER");
    if (!await rejectPartner(args[0], args[1], args[2], staff)) throw new Error("Partner ineligible for rejection");
    console.log("Partner rejection recorded in audit history");
  } else if (action === "revoke" && args.length === 3) {
    const staff = await staffFromEnvironment("REVOKER");
    if (!await revokePartner(args[0], args[1], args[2], staff)) throw new Error("Partner ineligible for revocation");
    console.log("Partner revocation recorded in audit history");
  } else {
    throw new Error("Usage: partner:register <id> <ARTIST|DISTRIBUTOR|LABEL> <name> | " +
      "partner:verify <id> <agreement-ref> <evidence-file> <reason> | " +
      "partner:reject <id> <evidence-file> <reason> | partner:revoke <id> <evidence-file> <reason>");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Partner command failed");
  process.exitCode = 1;
});