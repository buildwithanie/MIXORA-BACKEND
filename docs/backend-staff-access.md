# Backend staff Access boundary

Deployment target: `mixora-backend` at
`https://mixora-backend.buildwithanie.workers.dev`. The backend has not been verified live. An HTTP 404 from an undeployed
Worker is not evidence that Cloudflare Access protects a route.

The public `/` and `/api/catalog` paths remain available for metadata. The
`/api/media/[id]` path currently denies every public audio request. The separate
backend staff Access application must protect both `/api/staff` and
`/api/staff/*` on the backend hostname. The wildcard path covers nested routes,
including:

- `POST /api/staff/agreements`
- `GET /api/staff/agreements/{id}`
- `GET /api/staff/agreements/{id}/file`
- `POST /api/staff/agreements/{id}/decision`

The Cloudflare dashboard previously showed the separate `mixora-backend` Access
application targeting the backend hostname at both `/api/staff` and
`/api/staff/*`. Recheck this after deployment; edge enforcement is not yet
verified live. Its AUD is separate from
the `mixora-team` application used by the staff-login Worker. Confirm the
intended human allow policy and that no bypass or service-auth policy grants
human review access. Do not
protect all of `mixora-backend` without also planning for the public
catalogue route and the disabled media route. Cloudflare Access hostname/path rules only cover
matching URLs: inspect Workers preview URLs, version URLs, custom domains,
routes and any alternative hostname before production use. The primary Worker
configuration explicitly disables Version URLs with `previewUrls: false`;
verify the effective deployment configuration and remote setting before use.

The backend must have `CF_ACCESS_TEAM_DOMAIN` set to the HTTPS Access team
issuer and `CF_ACCESS_AUD` set to the backend staff application's separate AUD.
The backend
validates the RS256 signature from the issuer JWKS, issuer, audience, expiry,
human subject and an active D1 role for every staff API request. It does not
accept a caller-supplied reviewer ID or use an app session cookie. A public
alternate hostname cannot bypass these origin checks, but can bypass the
Access edge policy if its hostname/path is not covered. Test both layers.

After an authorised deployment, anonymously request each staff route on
every reachable hostname and confirm denial. Then test a valid human JWT
with no role (403), a role assigned in D1 (operation-specific success), and
the same JWT after disabling the role (403). Never include a JWT or cookie in
logs or a support ticket. Verify that the public catalogue still works.

Access session duration and per-user revocation are configured in Cloudflare,
not in this code. Disabling a D1 staff grant blocks the next authorisation
lookup, independent of an Access session. The review-event D1 triggers also
recheck the active grant at decision time.
