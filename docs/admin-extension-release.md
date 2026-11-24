# Administrator extension and first Worker release

Status: local preparation only, 24 November 2026. Neither the administrator extension nor the backend Worker deployment has been executed.

## Verified local baseline

- The sole enabled administrator expires at 2026-11-27 12:43:07 UTC. A 30-day extension measured from that expiry would end at 2026-12-27 12:43:07 UTC (15:43:07 EAT).
- The protected D1 export is `C:\Users\Ann\MIXORA-Secure-Backups\D1\mixora-db-20261124T053321Z-26151d75.sql`. Its SHA-256 is `B4CD39927DF7B96EECFDEB5D20B89089A0C4FBF5D5F5172BA48A9635D044AD92`. The matching bookmark and checksum sidecar are in that folder.
- On 24 November the export replayed into an in-memory SQLite database. `PRAGMA integrity_check` returned `ok`; the six expected tables and original administrator expiry were present. This does not test a Cloudflare Time Travel restore.
- Local automated tests, typecheck and vinext build passed on 24 November. Re-run them after any code change or immediately before release if the source snapshot changes.

## Exceptional administrator extension: separate production approval required

This table is a bootstrap exception. Migration 0006's `catalog_staff_role_events` HMAC chain does not cover `catalog_staff_admins`. Never use `pnpm staff:role` to extend the administrator bootstrap row.

Before the write, confirm the full administrator row still matches the protected export, exactly one administrator row exists and it is enabled, the backup hash still matches, and the expiry is still the expected old value. Obtain a fresh D1 Time Travel bookmark immediately before the change. Keep the verified Access subject only in process memory; do not place it in a shell command, email, audit text or logs. The existing `CatalogDatabase.query` adapter binds non-null values.

The reviewed single-field change is:

```ts
const oldExpiry = "2026-11-27 12:43:07";
const newExpiry = "2026-12-27 12:43:07";
const result = await db().query(
  `UPDATE catalog_staff_admins
   SET expires_at = $1
   WHERE subject = $2
     AND enabled = 1
     AND expires_at = $3
     AND datetime(expires_at) > datetime('now')
     AND (SELECT COUNT(*) FROM catalog_staff_admins) = 1`,
  [newExpiry, verifiedSubject, oldExpiry],
);
if (result.changes !== 1) throw new Error("Administrator extension not confirmed");
```

The only SET field is `expires_at`. Zero changed rows means stop and inspect, not retry. Do not run this snippet from `wrangler d1 execute --command` with an interpolated subject. The owner must approve this exact expiry and the separate audit process before execution.

## Independent change record

The account-owned D1 token is not a verified human identity. Record the named human owner approving the change and the operator executing it separately. Before execution, prepare a canonical change record containing the reason, approval reference, subject fingerprint (never raw subject), old and new expiry, SQL hash, backup SHA-256, bookmark-file reference and planned checks. Keep the private record in the protected backup folder. Send its SHA-256 and the exact expiry change to a user-controlled, MFA-protected email account outside Cloudflare and the local computer; retain the original provider-timestamped email and this chat approval. After execution, append the UTC execution time, one-row change result, full-row comparison result, audit-chain results and D1 health check; send the final record hash to the same mailbox. Do not email the D1 export, JWT or credentials.

This gives an independent evidence copy for this one-administrator exception, but is not an immutable WORM log or a second administrator's approval. If an independent mailbox cannot be confirmed, postpone the write.

## Verification and recovery

After a one-row update, read back the row and compare every field with the pre-change snapshot; only `expires_at` may differ. Confirm exactly one enabled administrator with the new expiry, then run `pnpm audit:verify` and `pnpm staff:role-audit` and a read-only `SELECT 1`. Preserve the new bookmark and change receipt.

If the update affects zero rows or any post-check fails, stop. A corrective single-field update requires a fresh diagnosis and separate approval. Never automatically run Time Travel restore: it overwrites production D1 and can erase intervening changes. The local replay proves the SQL export is parseable; a production restore remains untested.

## Source traceability and first Worker release

Keep this backend in its own Git repository. Record a local source commit and release tag after local checks. Confirm that `.env.local`, `.worker.secrets`, `data/`, generated build outputs and any backup export are ignored and absent from the commit. Retain the commit ID, lockfile hash, build date and generated deployment config summary in the release record. No remote Git mirror is currently configured, so the local repository is not an off-device source backup.

Before deployment, verify the local AUD format, the configured staff paths, production secret values by presence only, D1 and R2 bindings, and disabled preview URLs. After deployment, verify the actual backend Access AUD with a fresh JWT and check the public catalogue and disabled media route. A live backend JWT check may not be possible before the first Worker exists. The first deployment has no previous backend Worker version to roll back to. If post-deploy security checks fail, stop traffic or withdraw the Worker using a separately approved incident action, then redeploy a corrected, tested commit. Do not use D1 Time Travel as a Worker-code rollback.

Production actions should be approved as one reviewed sequence: independent audit anchor, fresh bookmark, conditional administrator extension and checks, secure Worker secret provisioning, first Worker deployment and post-deploy route/Access tests. Do not proceed past a failed gate.