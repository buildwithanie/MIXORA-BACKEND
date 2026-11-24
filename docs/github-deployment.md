# GitHub Actions deployment

The workflow in `.github/workflows/mixora-worker.yml` tests, typechecks, and builds on pushes to `main`, pull requests, and manual runs. Only a manual run on `main` can reach the production job. The production job rebuilds the same commit after approval and uses the established `cf deploy --prebuilt --mode production --no-provision` path. It does not create previews or provision replacement D1 or R2 resources. It fails if the existing Worker is absent or preview URLs are enabled. External GitHub Actions are pinned to verified upstream commit SHAs.

## GitHub settings required before deployment

In `buildwithanie/MIXORA-BACKEND`:

1. **Settings > Environments > New environment:** create `production`. Enable **Required reviewers** and select a trusted user or team with repository read access. The workflow checks this rule and fails if it is absent. Under **Deployment branches and tags**, choose selected branches and allow only `main`. Enable **Prevent self-review** when a second eligible reviewer is available.
2. Add only `CLOUDFLARE_API_TOKEN` as a `production` **environment secret**. Use a separate account-owned token with **Editor** scoped only to the existing `mixora-backend` Worker. Do not use the D1 token or account-wide Workers Admin.
3. Add `CLOUDFLARE_ACCOUNT_ID` as a `production` environment **variable** for the account owning the Worker, D1, and R2 buckets. It is an identifier, not a deployment secret.
4. Under **Settings > Actions > General**, retain read-only default workflow permissions. The deployment job explicitly requests `actions: read` to inspect environment protection. Protect `main` and restrict who may edit workflows.
5. In Cloudflare Workers Builds / Git integration, verify that independent automatic production builds and preview builds are disabled. Leave Worker Version URLs disabled. GitHub Actions cannot control Cloudflare's separate Git integration.

To deploy later, select **Actions > MIXORA backend > Run workflow > main**. The verify job must pass; a required reviewer must then approve the `production` environment. GitHub releases its deployment token only after approval. This preparation does not run the workflow or deploy.

The existing `cloudflare.config.ts` retains `MIXORA_DB` for `mixora-db`, `MIXORA_AUDIO` for `mixora-audio`, and `MIXORA_AGREEMENTS` for `mixora-legal-agreements`. Native R2 bindings do not require S3 keys in GitHub. The three existing Worker runtime secrets (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `MIXORA_AUDIT_HMAC_KEY`) remain stored in Cloudflare. The workflow omits `--secrets-file`; Cloudflare preserves existing secret bindings on code deployments. Do not copy these values into GitHub, change their names, or rotate the audit key as part of this workflow. Verify the bindings and secret names after any approved deployment.

After deployment, follow `docs/workers-deployment.md` to verify the catalogue, anonymous staff denial, a fresh backend Access JWT, public media denial, bindings, version URLs, and reachable hostnames. The workflow does not apply migrations, rotate secrets, change D1/R2 data, or deploy Android.
