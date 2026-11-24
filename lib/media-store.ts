import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { workerBindings, type MixoraWorkerEnv } from "./worker-bindings";

export type StoredMedia = {
  bytes: number;
  mimeType: string;
  sha256: string | null;
};
export type MediaObject = StoredMedia & { body: ReadableStream<Uint8Array> };
export type MediaStore = {
  put(key: string, bytes: Buffer, mimeType: string, sha256: string): Promise<void>;
  head(key: string): Promise<StoredMedia | null>;
  get(key: string): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
};

export class MediaObjectConflictError extends Error {
  constructor() {
    super("Audio object already exists; refusing to overwrite it");
    this.name = "MediaObjectConflictError";
  }
}

const globalStore = globalThis as typeof globalThis & { mixoraMediaStore?: MediaStore };

function validKey(key: string): void {
  if (!/^[a-f0-9-]{36}\.(mp3|m4a|ogg|flac|wav)$/i.test(key)) throw new Error("Invalid R2 audio key");
}

class R2MediaStore implements MediaStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;
    if (!account || !accessKeyId || !secretAccessKey || !bucket) throw new Error("Cloudflare R2 is not configured");
    const endpoint = process.env.R2_ENDPOINT || `https://${account}.r2.cloudflarestorage.com`;
    if (!endpoint.startsWith("https://")) throw new Error("R2 endpoint must use HTTPS");
    this.bucket = bucket;
    this.client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, maxAttempts: 2 });
  }

  async put(key: string, bytes: Buffer, mimeType: string, sha256: string): Promise<void> {
    validKey(key);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key,
        Body: bytes, ContentType: mimeType, Metadata: { sha256 }, IfNoneMatch: "*" }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412 ||
          (error as { name?: string }).name === "PreconditionFailed") {
        throw new MediaObjectConflictError();
      }
      throw error;
    }
  }

  async head(key: string): Promise<StoredMedia | null> {
    validKey(key);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: result.ContentLength ?? 0, mimeType: result.ContentType ?? "application/octet-stream",
        sha256: result.Metadata?.sha256 ?? null };
    } catch (error) {
      if (["NotFound", "NoSuchKey", "NoSuchObject"].includes((error as { name?: string }).name ?? "")) return null;
      throw error;
    }
  }

  async get(key: string): Promise<MediaObject | null> {
    validKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      return { bytes: result.ContentLength ?? 0, mimeType: result.ContentType ?? "application/octet-stream",
        sha256: result.Metadata?.sha256 ?? null,
        body: result.Body.transformToWebStream() as ReadableStream<Uint8Array> };
    } catch (error) {
      if (["NoSuchKey", "NotFound"].includes((error as { name?: string }).name ?? "")) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    validKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export class BoundMediaStore implements MediaStore {
  constructor(private readonly bucket: MixoraWorkerEnv["MIXORA_AUDIO"]) {}

  async put(key: string, bytes: Buffer, mimeType: string, sha256: string): Promise<void> {
    validKey(key);
    const created = await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: mimeType }, customMetadata: { sha256 },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (!created) throw new MediaObjectConflictError();
  }

  async head(key: string): Promise<StoredMedia | null> {
    validKey(key);
    const object = await this.bucket.head(key);
    return object ? { bytes: object.size, mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
      sha256: object.customMetadata?.sha256 ?? null } : null;
  }

  async get(key: string): Promise<MediaObject | null> {
    validKey(key);
    const object = await this.bucket.get(key);
    return object ? { bytes: object.size, mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
      sha256: object.customMetadata?.sha256 ?? null, body: object.body } : null;
  }

  async delete(key: string): Promise<void> {
    validKey(key);
    await this.bucket.delete(key);
  }
}

export function mediaStore(): MediaStore {
  if (process.env.MIXORA_WORKER === "1") return new BoundMediaStore(workerBindings().MIXORA_AUDIO);
  return (globalStore.mixoraMediaStore ??= new R2MediaStore());
}
