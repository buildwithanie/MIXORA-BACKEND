import { getCloudflareContext } from "@opennextjs/cloudflare";

// Wrangler provides these bindings only to the deployed backend Worker.
export type MixoraWorkerEnv = {
  MIXORA_DB: {
    prepare(sql: string): { bind(...values: string[]): { all<T>(): Promise<{
      success: boolean; results: T[]; meta?: { changes?: number };
    }> } };
  };
  MIXORA_AUDIO: {
    put(key: string, body: Uint8Array, options: {
      httpMetadata: { contentType: string }; customMetadata: Record<string, string>;
      onlyIf: Headers;
    }): Promise<{ size: number } | null>;
    head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string> } | null>;
    get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array>;
      httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
    delete(key: string): Promise<void>;
  };
  MIXORA_AGREEMENTS: {
    put(key: string, body: Uint8Array, options: {
      httpMetadata: { contentType: string }; customMetadata: Record<string, string>;
      onlyIf: Headers;
    }): Promise<{ size: number } | null>;
    head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
    get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array>;
      httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
    delete(key: string): Promise<void>;
  };
};

export function workerBindings(): MixoraWorkerEnv {
  if (process.env.MIXORA_WORKER !== "1") throw new Error("Worker bindings are unavailable outside the backend Worker");
  const env = getCloudflareContext().env as unknown as Partial<MixoraWorkerEnv>;
  if (!env.MIXORA_DB || !env.MIXORA_AUDIO || !env.MIXORA_AGREEMENTS) {
    throw new Error("MIXORA Worker bindings are incomplete");
  }
  return env as MixoraWorkerEnv;
}
