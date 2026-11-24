import "../lib/load-env";
import { syncProvider } from "./sync-provider";

async function loop() {
  while (true) {
    if (process.env.PROVIDER_FEED_URL) {
      try { await syncProvider(); }
      catch (error) { console.error("Provider sync failed", error); }
    }
    await new Promise((resolve) => setTimeout(resolve, 6 * 60 * 60 * 1_000));
  }
}

loop().catch((error) => { console.error(error); process.exitCode = 1; });
