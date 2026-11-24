# MIXORA backend Worker preparation

This project is the real Next.js backend. `mixora-staff-login` is a separate Worker and is not part of this deployment. Nothing in this document has been deployed.

## Deployment target and adapter

- Worker name: `mixora-backend`.
- Planned URL: `https://mixora-backend.buildwithanie.workers.dev`. This URL must be checked after the first deployment; it is not a currently verified live endpoint.
- `cloudflare.config.ts` explicitly sets `previewUrls: false` so Version URLs remain disabled. Keep the intended production `workers.dev` hostname available for the public catalogue. Verify the effective deployment configuration before deployment and the actual Cloudflare setting afterward; do not assume the local setting proves the remote state. Do not create separate Worker Previews without their own Access protection. Check every reachable custom domain, route, and alternate hostname for staff Access coverage.
- Primary adapter: vinext for Cloudflare. It builds the existing App Router and route handlers with Vite on Windows. `pnpm dev` and `pnpm build` remain available for the original Next.js development workflow.
- The OpenNext configuration remains only as a fallback. Its package step fails on this Windows machine because of a symbolic-link permission error. Do not use the `worker:*` scripts or `wrangler.jsonc` for the planned deployment.
- Local vinext build: `pnpm build:vinext`. Validation-only CLI command: `pnpm exec vinext-cloudflare deploy --dry-run`. The dry run reports that it does not build or deploy; run the build first. Neither command changes remote resources.

## Bindings and runtime configuration

`cloudflare.config.ts` binds the existing D1 database `mixora-db` as `MIXORA_DB`, the private `mixora-audio` bucket as `MIXORA_AUDIO`, and the private `mixora-legal-agreements` bucket as `MIXORA_AGREEMENTS`. The configured D1 ID was taken from the existing local configuration and its name confirmed via a read-only Cloudflare lookup. Do not point these bindings at test or different production resources without reviewing the effects.

In a deployed Worker, `lib/db.ts` uses the D1 binding and `lib/media-store.ts` and `lib/agreement-store.ts` use their respective R2 bindings. vinext maps the existing binding helper to native `cloudflare:workers` bindings during its build. Existing local commands and `next dev` still use the D1 REST adapter and separate R2 S3 credentials in `.env.local`. Do not set `MIXORA_WORKER=1` in `.env.local` for those commands.

The Worker does **not** need `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_AGREEMENTS_ACCESS_KEY_ID`, `R2_AGREEMENTS_SECRET_ACCESS_KEY`, or `R2_ENDPOINT` at runtime. Keep those out of Worker secrets. The deployment CLI itself will need an appropriately scoped Cloudflare login or separate deployment credential.

`PUBLIC_CATALOG_ORIGIN` is set to the planned HTTPS Workers URL in `cloudflare.config.ts` as a text binding. Verify the actual URL before offering catalogue sync to Android. The runtime rejects missing or non-HTTPS origins in production. `/api/catalog` preserves `schemaVersion: 1`, `generatedAt`, and `tracks`. It queries only eligible published tracks through D1. `/api/media/[id]` temporarily denies all public audio requests before any D1 or R2 read; `audioUrl` remains in the catalogue response but is unavailable. Neither public endpoint reads the agreement bucket.

The staff routes require these production secrets:

| Name | Purpose |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | Existing Cloudflare Access team issuer |
| `CF_ACCESS_AUD` | Audience of the separate backend staff Access application; it must match the application protecting the backend staff paths |
| `MIXORA_AUDIT_HMAC_KEY` | Existing audit-chain signing key; changing it invalidates historical verification |

Use a gitignored `.worker.secrets` file containing **only** those three entries when deployment is authorised. Do not copy `.env.local` wholesale into a Worker. For a first vinext deployment, `cf deploy --prebuilt --mode production --secrets-file .worker.secrets` supplies them alongside the already built code. This command **deploys** and must not be run during preparation. Keep that file private and remove it securely after deployment. Do not create a new audit key in place of the existing one. The current local build-output scan found no configured token or key values in generated Worker files. An earlier credential-exposure concern remains unresolved; determine whether any value actually left the trusted machine before deployment, and preserve audit-key continuity if rotation is required.

The existing `mixora-team` Access application protects the separate staff-login Worker. The separate backend staff Access application must protect both `/api/staff` and `/api/staff/*` on the backend hostname, with its own AUD supplied as `CF_ACCESS_AUD`. A wildcard child path does not protect the parent path. The route code checks signature, issuer, audience, expiry, human identity, and active D1 roles; it does not accept a free-form reviewer ID. Do not add a broad bypass for browser convenience.

## Verification before a future deployment

From Windows PowerShell in the independent `MIXORA-BACKEND` directory:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build:vinext
pnpm exec vinext-cloudflare deploy --dry-run
```

The local vinext preview has returned HTTP 200 for an empty v1 catalogue after the existing schema and migrations were applied only to its D1 emulator; an anonymous staff upload returned 401. A dry run does not exercise live D1, R2, or Cloudflare Access. Before any authorised deployment, confirm the built Worker size is within the account's plan limit and set up a scoped deployment identity. After deployment, check `/api/catalog` returns HTTP 200 with the expected v1 shape, the home page responds, staff routes reject anonymous requests, and `/api/media/[id]` denies every ID without touching D1 or R2. Do not enable commercial audio until listener entitlements and licensing controls are completed.

No Android project files or existing D1/R2 data are changed by this preparation.

## Release traceability and recovery

Follow [administrator extension and first release](admin-extension-release.md). A local Git snapshot is needed before deployment. There is no previous backend Worker version for the first release, so production rollback must be planned as an incident action. A D1 Time Travel restore is not a Worker-code rollback.
