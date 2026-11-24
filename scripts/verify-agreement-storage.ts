import "../lib/load-env";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { agreementStore } from "../lib/agreement-store";
import { publishedTracks } from "../lib/catalog";
import { GET as publicMediaGet } from "../app/api/media/[id]/route";

function syntheticPdf(): Buffer {
  const label = "MIXORA STAGE 3 SYNTHETIC TEST DOCUMENT - NO LEGAL EFFECT";
  const stream = "BT /F1 12 Tf 30 120 Td (" + label + ") Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 440 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(stream, "ascii") + " >>\nstream\n" + stream + "endstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += (index + 1) + " 0 obj\n" + object + "\nendobj\n";
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(pdf, "ascii");
}

async function main(): Promise<void> {
  const bucket = process.env.R2_AGREEMENTS_BUCKET;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_AGREEMENTS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_AGREEMENTS_SECRET_ACCESS_KEY;
  assert.equal(bucket, "mixora-legal-agreements", "Unexpected agreement bucket");
  assert.match(account ?? "", /^[a-f0-9]{32}$/i, "Invalid Cloudflare account configuration");
  assert.ok(accessKeyId && secretAccessKey, "Separate agreement R2 credentials required");
  assert.notEqual(accessKeyId, process.env.R2_ACCESS_KEY_ID, "Music and agreement access keys must differ");
  assert.notEqual(secretAccessKey, process.env.R2_SECRET_ACCESS_KEY, "Music and agreement secrets must differ");
  const bytes = syntheticPdf();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = "agreements/" + randomUUID() + ".pdf";
  const store = agreementStore();
  assert.equal(await store.head(key), null, "Synthetic test key already exists");
  let uploaded = false;
  try {
    await store.put(key, bytes, sha256);
    uploaded = true;
    const metadata = await store.head(key);
    assert.equal(metadata?.byteSize, bytes.length, "R2 file size mismatch");
    assert.equal(metadata?.sha256, sha256, "R2 checksum metadata mismatch");
    const object = await store.get(key);
    assert.ok(object, "Synthetic test document not retrievable");
    assert.equal(object.mimeType, "application/pdf", "R2 MIME type mismatch");
    assert.equal(object.sha256, sha256, "Retrieved checksum metadata mismatch");
    assert.equal(object.bytes.length, bytes.length, "Retrieved file size mismatch");
    assert.equal(createHash("sha256").update(object.bytes).digest("hex"), sha256,
      "Retrieved document SHA-256 mismatch");
    assert.deepEqual(object.bytes, bytes, "Retrieved document differs byte-for-byte");
    const id = key.slice("agreements/".length, -".pdf".length);
    const publicResponse = await publicMediaGet(new Request("https://catalog.example.invalid/api/media/" + id),
      { params: Promise.resolve({ id }) });
    assert.equal(publicResponse.status, 404, "Agreement object exposed through public media");
    assert.ok(!(await publishedTracks()).some((track) => track.id === id),
      "Agreement object exposed through public catalogue");
    console.log("Live agreement R2 upload, metadata, SHA-256, byte-for-byte retrieval, and public-route isolation passed.");
  } finally {
    if (uploaded) {
      const client = new S3Client({ region: "auto",
        endpoint: "https://" + account + ".r2.cloudflarestorage.com",
        forcePathStyle: true, maxAttempts: 2,
        credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! } });
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } finally { client.destroy(); }
      assert.equal(await store.head(key), null, "Synthetic test object cleanup failed");
      console.log("Synthetic agreement R2 object removed and absence verified.");
    }
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  console.error("Agreement storage verification failed (" + name +
    (status ? ", HTTP " + status : "") + "); no credentials were logged.");
  process.exitCode = 1;
});

