import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { workerBindings } from "./worker-bindings";

export type AgreementObject = { bytes: Buffer; mimeType: string; sha256: string | null };
export type AgreementStore = {
  put(key: string, bytes: Buffer, sha256: string): Promise<void>;
  head(key: string): Promise<{ byteSize: number; sha256: string | null; writeId: string | null } | null>;
  get(key: string): Promise<AgreementObject | null>;
  delete(key: string): Promise<void>;
};
const globalStore = globalThis as typeof globalThis & { mixoraAgreementStore?: AgreementStore };
const keyPattern = /^agreements\/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.pdf$/i;
function checkedKey(key: string): void {
  if (!keyPattern.test(key)) throw new Error("Invalid agreement object key");
}
class R2AgreementStore implements AgreementStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor() {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKeyId = process.env.R2_AGREEMENTS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_AGREEMENTS_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_AGREEMENTS_BUCKET;
    if (!account || !accessKeyId || !secretAccessKey || !bucket) throw new Error("Private agreement R2 bucket is not configured");
    if (bucket === process.env.R2_BUCKET || accessKeyId === process.env.R2_ACCESS_KEY_ID ||
        secretAccessKey === process.env.R2_SECRET_ACCESS_KEY) {
      throw new Error("Agreement storage must use a separate bucket and credentials");
    }
    const endpoint = "https://" + account + ".r2.cloudflarestorage.com";
    this.bucket = bucket;
    this.client = new S3Client({ region: "auto", endpoint, forcePathStyle: true, maxAttempts: 2,
      credentials: { accessKeyId, secretAccessKey } });
  }
  async put(key: string, bytes: Buffer, sha256: string): Promise<void> {
    checkedKey(key);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes,
        ContentType: "application/pdf", Metadata: { sha256, writeid: key.slice(11, -4) },
        IfNoneMatch: "*" }));
    } catch (error) {
      if ((error as { name?: string }).name === "PreconditionFailed" ||
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) {
        throw new Error("Agreement object already exists; refusing to overwrite it");
      }
      throw error;
    }
  }
  async delete(key: string): Promise<void> {
    checkedKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async head(key: string): Promise<{ byteSize: number; sha256: string | null; writeId: string | null } | null> {
    checkedKey(key);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { byteSize: result.ContentLength ?? 0, sha256: result.Metadata?.sha256 ?? null,
        writeId: result.Metadata?.writeid ?? null };
    } catch (error) {
      if (["NotFound", "NoSuchKey", "NoSuchObject"].includes((error as { name?: string }).name ?? "")) return null;
      throw error;
    }
  }
  async get(key: string): Promise<AgreementObject | null> {
    checkedKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      if ((result.ContentLength ?? 0) > 10 * 1024 * 1024) throw new Error("Agreement object exceeds 10 MB");
      const reader = result.Body.transformToWebStream().getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 10 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Agreement object exceeds 10 MB");
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return { bytes: Buffer.concat(chunks, size),
        mimeType: result.ContentType ?? "application/octet-stream", sha256: result.Metadata?.sha256 ?? null };
    } catch (error) {
      if (["NotFound", "NoSuchKey"].includes((error as { name?: string }).name ?? "")) return null;
      throw error;
    }
  }
}
class BoundAgreementStore implements AgreementStore {
  private bucket() { return workerBindings().MIXORA_AGREEMENTS; }
  async put(key: string, bytes: Buffer, sha256: string): Promise<void> {
    checkedKey(key);
    const created = await this.bucket().put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { sha256, writeId: key.slice(11, -4) },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (!created) throw new Error("Agreement object already exists; refusing to overwrite it");
  }
  async delete(key: string): Promise<void> {
    checkedKey(key);
    await this.bucket().delete(key);
  }
  async head(key: string): Promise<{ byteSize: number; sha256: string | null; writeId: string | null } | null> {
    checkedKey(key);
    const object = await this.bucket().head(key);
    return object ? { byteSize: object.size, sha256: object.customMetadata?.sha256 ?? null,
      writeId: object.customMetadata?.writeId ?? null } : null;
  }
  async get(key: string): Promise<AgreementObject | null> {
    checkedKey(key);
    const object = await this.bucket().get(key);
    if (!object) return null;
    if (object.size > 10 * 1024 * 1024) throw new Error("Agreement object exceeds 10 MB");
    const reader = object.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 10 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("Agreement object exceeds 10 MB");
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks, size), mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
      sha256: object.customMetadata?.sha256 ?? null };
  }
}
export function agreementStore(): AgreementStore {
  if (process.env.MIXORA_WORKER === "1") return new BoundAgreementStore();
  return (globalStore.mixoraAgreementStore ??= new R2AgreementStore());
}


