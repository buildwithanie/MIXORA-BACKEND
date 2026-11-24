# Partner and rights review workflow

All commands run on a trusted operator machine with scoped Cloudflare credentials. Human review commands additionally require a verified Cloudflare Access application JWT in the transient `CF_ACCESS_JWT` environment variable and an active role grant in `catalog_staff_roles`. `CF_ACCESS_TEAM_DOMAIN` in `.env.local` identifies the shared Access team issuer; `CF_ACCESS_AUD` must match the separate `mixora-backend` staff Access application, not the `mixora-team` application protecting the staff-login Worker. The backend verifies the JWT signature against Cloudflare's rotating keys, issuer, audience, expiry and human subject before querying roles. Keep the JWT out of `.env.local`, command history and logs. Staff agreement endpoints require verified Access JWTs and active D1 roles. Imported audio is stored in private R2; metadata is stored in D1. Files, manifests and agreements supplied by artists or providers must be reviewed outside the app before using these commands. A checksum proves which document was reviewed; it does not prove that the document grants rights.

1. Register an independent artist with `pnpm partner:register artist:<stable-id> ARTIST "Artist name"`, or a distributor/label with kind `DISTRIBUTOR` or `LABEL`. New partners are `PENDING`. This command never changes an existing partner's kind or status and records the verified registrar subject as submitter.
2. Upload the partner PDF through the authenticated staff agreement API, then have an independent PARTNER_VERIFIER inspect and verify it. Run pnpm partner:verify <partner-id> <agreement-id> <same-local-agreement-pdf> "<reason>". This command rechecks the private R2 PDF and SHA-256 before approving the partner. The verifier must differ from the registrar. See [protected agreement procedures](protected-agreements.md). Use pnpm partner:reject or pnpm partner:revoke with evidence and a reason when appropriate.
3. Import a reviewed artist or provider manifest with `pnpm catalog:import-manifest <manifest.json>`. For inbox files, use `pnpm catalog:import`. The importer validates audio and checksum, stores it in R2, records metadata and rights claims in D1, and leaves every new or changed track unpublished. Manual commercial manifest imports require a verified PARTNER_REGISTRAR JWT and record that subject as submitter. Inbox and development imports without a verified submitter remain ineligible for rights approval. Existing provider feeds stay disabled until an authorised feed is configured.
4. A different reviewer checks track-specific distribution, offline playback and mixing permissions, the rights holder, agreement evidence, attribution, expiry and R2 bytes. Run `pnpm catalog:review <track-uuid> <local-rights-evidence-file> "<reason>"`, or `pnpm catalog:reject <track-uuid> <evidence-file> "<reason>"`. Each decision records the verified subject, reason, exact import fingerprint, audio SHA-256, evidence-file SHA-256, partner agreement SHA-256 where present, and time. The reviewer must differ from the track submitter, partner submitter, and partner verifier.
5. Run `pnpm catalog:publish <track-uuid>`. The command checks R2 again. D1 rejects publication unless the latest review is approved and the partner remains verified. Public catalogue and media reads repeat the review and rights checks.
6. To revoke access, run `pnpm catalog:unpublish <partner-id> <external-track-id> <evidence-file> "<reason>"`. It records a revocation under the verified staff subject, unpublishes the track and removes its R2 audio. A later identical import cannot reuse the old approval. A successful Android full-snapshot sync removes the revoked offline copy.

Role grants are never seeded automatically. After the Access application exists, use a verified human `sub` and a trusted D1 administrator to grant only the required role; record the grantor in `granted_by`. Roles are `PARTNER_REGISTRAR`, `PARTNER_VERIFIER`, `RIGHTS_REVIEWER`, `PUBLISHER`, `REVOKER` and read-only `AUDITOR`. Disable a grant by setting `enabled=0`; expiration is supported. Service tokens and unverified identities cannot perform human review actions. The existing `mixora-team` Cloudflare Access application protects the separate `mixora-staff-login` Worker at https://mixora-staff-login.buildwithanie.workers.dev/ and uses an exact-email allow policy. The Worker source is `cloudflare/staff-login.js`. A prior live read-only CLI JWT authorization passed on 18 November 2026 using the earlier Access application; that result does not verify the new backend application's AUD or a fresh backend JWT. Other staff actions still require their own explicit grants. Do not publish commercial tracks until actual agreements are verified, listener entitlements and the remaining production controls are in place. A successful protected-storage test alone does not establish music rights.

## Post-deployment read-only staff authentication check

`pnpm staff:verify` uses the existing Cloudflare Access JWT validator and D1 role lookup. It requires an application JWT for a human with an active `PARTNER_REGISTRAR` grant, checks that no other active staff roles are present, and makes no D1 or R2 writes. It prints no JWT, cookie, email, or subject. The command cannot authenticate a browser session by itself; `CF_ACCESS_JWT` must be set only in the current shell process, never in `.env.local`.

After the backend Worker and its separate Access application are live, use that application's protected `/api/staff` URL to obtain a fresh JWT. A token from the old staff-login application has a different AUD and must not be used for backend commands. On Windows PowerShell, after installing `cloudflared`, open a new PowerShell window so the updated PATH is available, then run from the backend directory. If the command is still not found, run it by full path from the Windows Package Manager installation under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe`.

```powershell
$backendStaffUrl = 'https://mixora-backend.buildwithanie.workers.dev/api/staff'
cloudflared access login $backendStaffUrl
try {
  $env:CF_ACCESS_JWT = (cloudflared access token -app=$backendStaffUrl).Trim()
  pnpm staff:verify
  if ($LASTEXITCODE -ne 0) { throw "Staff verification failed" }
} finally {
  Remove-Item Env:CF_ACCESS_JWT -ErrorAction SilentlyContinue
}
```

Do not print or paste the token. If the check fails, report only its generic error message and exit status.

## Stage 2 decision audit

Migration `0004_review_audit` adds `catalog_review_events` without deleting older D1 rows. Human partner and track APPROVED, REJECTED, and REVOKED decisions are append-only. Every human decision requires an active Cloudflare Access staff role, a reason of 8-1000 characters, a local evidence file whose SHA-256 is recorded, and an exact metadata version. Track events also bind the audio SHA-256 and current rights-evidence reference. The event's actor is the verified Access JWT subject, never a CLI reviewer argument. Separate D1 triggers project track decisions into the legacy `catalog_rights_reviews` table so existing publication guards and API v1 responses retain their behavior. A REJECTED track projects as a blocking REVOKED legacy review; its explicit REJECTED decision remains in the audit event. Provider feed removal uses a distinct `SOURCE_WITHDRAWN` event with the named system actor, not a human review decision.

The event chain uses HMAC-SHA-256 with a 256-bit `MIXORA_AUDIT_HMAC_KEY` stored outside D1 in gitignored `.env.local`. The key must also be provisioned securely in every production runtime before review commands can work. Each event signs its fields and the preceding event hash. D1 triggers reject updates/deletes to audit events and older review rows, and reject direct new legacy review inserts. Run `pnpm audit:verify` to read and verify the full chain; a mismatch must be investigated before making another decision.

D1 administrators or anyone holding D1 write credentials can drop triggers, change rows, or truncate the log. The HMAC key prevents a D1-only attacker from recomputing valid hashes, but a missing tail cannot be detected without a checkpoint stored outside D1. Compromise of both D1 write access and the HMAC key defeats this protection. Before production use, export signed chain-head checkpoints to an independent, access-controlled log and restrict/rotate D1 credentials. Stage 3 stores private agreement PDFs, records their checksums and verifies byte integrity. A human must still assess legal validity; a checksum alone does not prove rights. See [protected agreement procedures](protected-agreements.md).

## Staff-role administration (migration 0006)

Migration `0006_staff_administration` adds a separate `catalog_staff_admins`
bootstrap table and an append-only, HMAC-linked `catalog_staff_role_events`
table. It does not change existing grants or review events. No administrator
is seeded. A trusted D1 operator must provision the first verified human
Access subject in `catalog_staff_admins` through a separately controlled
bootstrap procedure. Do not invent or guess that subject. Keep the initial
bootstrap and later changes in an independent administrative record.

After provisioning, `pnpm staff:role <grant|disable|expiry> <subject-uuid>
<role> <UTC-expiry|none> <evidence-file> <reason>` requires a fresh, verified
human Access JWT in the transient `CF_ACCESS_JWT` environment variable and
an active `catalog_staff_admins` record. It hashes the evidence file, rejects
self-role changes, and inserts a signed event. D1 triggers atomically apply
the role change in the same statement. `pnpm staff:role-audit` verifies the
chain and current projections. Do not run these commands against production
until bootstrap, backup, and Access coverage have been reviewed.

Migration 0006 guards direct `catalog_staff_roles` insert, update and delete:
role changes must be projected by the latest signed event. Legacy grants
remain intact but have no event in this new chain. A D1 administrator can
drop triggers or truncate logs, so export signed chain-head checkpoints
outside D1 and strictly limit D1 write credentials. The initial administrator and registrar grants were provisioned separately;
confirm their live state before use. Changes to `catalog_staff_admins` are not
covered by the staff-role event chain. See [administrator extension and release](admin-extension-release.md).
