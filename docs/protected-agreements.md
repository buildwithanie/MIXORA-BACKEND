# Protected agreements (Stage 3)

Migration `0005_protected_agreements` adds private agreement metadata and an append-only agreement audit chain. It creates no partner, agreement, role grant or public media. Apply with `pnpm db:migrate`. `pnpm audit:verify` checks both audit chains.

## Private R2 setup

Create a separate legal-document bucket, such as `mixora-legal-agreements`. Leave both `r2.dev` and custom-domain public access disabled. [Cloudflare says](https://developers.cloudflare.com/r2/buckets/public-buckets/) R2 buckets are private by default, but check the actual bucket settings. Create a separate S3 token scoped to this bucket with only required object read/write permissions. Configure `R2_AGREEMENTS_BUCKET`, `R2_AGREEMENTS_ACCESS_KEY_ID` and `R2_AGREEMENTS_SECRET_ACCESS_KEY` in gitignored `.env.local` or production secrets. The service rejects missing or shared music-bucket credentials and uses the account's canonical R2 endpoint. Never give this bucket to the public media Worker or Android. Rotate compromised credentials.

Supply `MIXORA_AUDIT_HMAC_KEY` separately from D1 and R2 credentials. An absent key blocks agreement actions. Supply a short-lived human Access JWT per trusted request; never store it in `.env.local`. The JWT signature, issuer, audience, expiry, human subject and active D1 role are checked before reading request bodies. Put the staff endpoints behind Cloudflare Access in production as an additional perimeter.

## Staff API

Each request supplies a verified human JWT in `Cf-Access-Jwt-Assertion`. No cookie or caller-supplied reviewer ID is accepted.

| Endpoint | Role | Behaviour |
| --- | --- | --- |
| `POST /api/staff/agreements` | PARTNER_REGISTRAR | Multipart `metadata` JSON and `file` PDF with `X-Content-SHA256`; 10 MB maximum; PENDING record. |
| `GET /api/staff/agreements/:id` | PARTNER_VERIFIER or AUDITOR | Private metadata without R2 key; inspection event. |
| `GET /api/staff/agreements/:id/file` | PARTNER_VERIFIER or AUDITOR | Rehashes R2 PDF, returns no-store attachment; retrieval event. |
| `POST /api/staff/agreements/:id/decision` | PARTNER_VERIFIER for VERIFIED/REJECTED; REVOKER for REVOKED | JSON `{"decision":"VERIFIED","reason":"..."}`; uploader cannot verify own document. |

The metadata JSON has `partnerId`, `agreementType` (ARTIST, DISTRIBUTOR, LABEL, ADDENDUM), `grantor`, `grantee`, boolean `distributionAllowed`, `offlineAllowed` and `mixAllowed`, ISO `validFrom` and nullable `validUntil`. The file must be PDF. The service checks PDF marker, size, client SHA-256, R2 metadata and downloaded bytes. A checksum identifies exact bytes; it cannot prove signatures, chain of title or that clauses grant the claimed rights. A human must inspect those before marking VERIFIED.

`partner:verify` now accepts the verified agreement ID as its agreement reference and the same local PDF; it rechecks private R2 bytes and checksum. New partner approval cannot rely only on a local file reference. Publication and public catalogue reads require a currently verified, unexpired agreement matching the partner's stored SHA-256. Revocation suspends a partner linked to that agreement and unpublishes its tracks.

Agreement actions use the existing audit key in a separate HMAC chain. D1 triggers reject edits/deletes of metadata and history; status changes require the latest decision event. D1 administrators can still drop triggers or truncate an audit tail. Keep signed chain-head checkpoints in an independently controlled log. Agreement uploads now use create-only R2 writes. If D1 insertion or the UPLOADED audit event fails after R2 succeeds, the application deletes only the newly created UUID object after checking its checksum and size. An inaccessible PENDING D1 row can remain; it is not served without a matching UPLOADED event. If cleanup cannot confirm or remove the object, the request fails with a reconciliation-required error. Investigate that key manually; cross-service atomicity is not available.

## Retention, backup and recovery

- Agree on a retention schedule with legal counsel covering contract terms, claims and privacy obligations. Until then, retain documents and audit history. There is no deletion API or automatic legal-bucket lifecycle rule.
- Back up the private bucket to a separately controlled encrypted location using separate credentials. Back up D1 metadata and events together. Keep the HMAC key in a secret manager with separate recovery control. Check each backup PDF against its D1 SHA-256 and store a signed audit-chain head independently.
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) has a limited recovery window based on plan; it is not a legal archive. Keep independent encrypted exports for the required period. A D1 restore overwrites current production state and needs incident review.
- Rehearse recovery in isolation: restore D1 and R2 copies, compare object counts and SHA-256 values, run `pnpm audit:verify`, compare independent chain heads, and confirm the bucket has no public domain. Keep publication disabled until rights are rechecked. Record operator, date and outcome.

The empty private bucket `mixora-legal-agreements` has been created. Its r2.dev access is disabled and it has zero custom domains. Separate bucket-scoped S3 credentials are configured in the gitignored local environment, and a synthetic upload/read/delete test passed previously. The deployed Worker uses its private R2 binding; do not provision S3 keys as Worker secrets. No real agreement is approved by this storage test.



To repeat the live storage smoke test, run `pnpm agreement:verify-storage`. It generates an original synthetic PDF, checks upload metadata and SHA-256, retrieves and compares bytes, verifies public-route isolation, and deletes only its random test object in a finally block. It does not write D1 records or handle real agreements.

