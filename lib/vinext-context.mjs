import { env } from "cloudflare:workers";

// vinext's replacement for the OpenNext context used by the existing adapters.
export function getCloudflareContext() {
  return { env };
}
