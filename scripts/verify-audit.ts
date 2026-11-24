import "../lib/load-env";
import { verifyAuditHistory } from "../lib/audit";
import { verifyAgreementAuditHistory } from "../lib/agreement-audit";
import { db } from "../lib/db";

Promise.all([verifyAuditHistory(), verifyAgreementAuditHistory()])
  .then(([reviews, agreements]) => console.log(
    "Audit hash chains verified (" + reviews + " review event(s), " +
    agreements + " agreement event(s))."))
  .catch(() => { console.error("Audit history verification failed"); process.exitCode = 1; })
  .finally(() => db().end().catch(() => undefined));
