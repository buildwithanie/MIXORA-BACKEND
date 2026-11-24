import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mock, test } from "node:test";
import { MediaObjectConflictError, mediaStore, type MediaStore } from "../lib/media-store";

test("music uploads use atomic create-only writes and report existing keys as conflicts", async () => {
  const names = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"] as const;
  const originalEnvironment = names.map((name) => [name, process.env[name]] as const);
  const globals = globalThis as typeof globalThis & { mixoraMediaStore?: MediaStore };
  const originalStore = globals.mixoraMediaStore;
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_BUCKET = "mixora-audio-test";
  delete process.env.R2_ENDPOINT;
  delete globals.mixoraMediaStore;

  const objects = new Map<string, Buffer>();
  const commands: PutObjectCommand[] = [];
  let deny = false;
  const send = mock.method(S3Client.prototype, "send", async (command: PutObjectCommand) => {
    assert.ok(command instanceof PutObjectCommand, "put must not perform a separate HEAD check");
    commands.push(command);
    if (deny) throw Object.assign(new Error("Access denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    const key = command.input.Key!;
    if (objects.has(key)) {
      throw Object.assign(new Error("Precondition failed"), {
        name: "PreconditionFailed", $metadata: { httpStatusCode: 412 },
      });
    }
    objects.set(key, Buffer.from(command.input.Body as Buffer));
    return {};
  });

  try {
    const store = mediaStore();
    const key = `${randomUUID()}.wav`;
    const first = Buffer.from("original synthetic audio");
    const second = Buffer.from("different synthetic audio");
    const sha256 = createHash("sha256").update(first).digest("hex");
    await store.put(key, first, "audio/wav", sha256);
    await assert.rejects(store.put(key, second, "audio/wav", createHash("sha256").update(second).digest("hex")),
      (error: unknown) => error instanceof MediaObjectConflictError && /already exists/.test(error.message));
    assert.deepEqual(objects.get(key), first, "the original audio must survive a conflicting upload");
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.equal(command.input.Bucket, "mixora-audio-test");
      assert.equal(command.input.IfNoneMatch, "*");
      assert.equal(command.input.ContentType, "audio/wav");
    }
    assert.equal(commands[0].input.Metadata?.sha256, sha256);
    deny = true;
    await assert.rejects(store.put(`${randomUUID()}.wav`, first, "audio/wav", sha256),
      (error: unknown) => error instanceof Error && error.name === "AccessDenied");
  } finally {
    send.mock.restore();
    globals.mixoraMediaStore = originalStore;
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
