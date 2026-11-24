import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "mixora-backend",
    entrypoint: "vinext/server/fetch-handler",
    previewUrls: false,
    compatibilityDate: "2026-11-20",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      MIXORA_DB: bindings.d1({ id: "99e8537b-bd8a-4ab7-815e-7fd2497b157b", name: "mixora-db" }),
      MIXORA_AUDIO: bindings.r2({ name: "mixora-audio" }),
      MIXORA_AGREEMENTS: bindings.r2({ name: "mixora-legal-agreements" }),
      MIXORA_WORKER: bindings.text("1"),
      PUBLIC_CATALOG_ORIGIN: bindings.text("https://mixora-backend.buildwithanie.workers.dev"),
      CF_ACCESS_TEAM_DOMAIN: bindings.secret(),
      CF_ACCESS_AUD: bindings.secret(),
      MIXORA_AUDIT_HMAC_KEY: bindings.secret(),
    },
  }),
});
