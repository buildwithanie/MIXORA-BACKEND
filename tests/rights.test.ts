import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "../scripts/import-catalog";
import { providerAudioHeaders } from "../scripts/sync-provider";

const approved = {
  externalId: "label-track-1", audioFile: "track.mp3", title: "Licensed Song",
  artist: "Artist", category: "GOSPEL" as const, language: "SWAHILI" as const,
  rightsHolder: "Artist Label", rightsBasis: "LABEL_CONTRACT" as const,
  rightsEvidenceRef: "contract-2026-001", distributionAllowed: true,
  offlineAllowed: true, mixAllowed: true,
};

test("accepts documented offline and DJ rights", () => {
  assert.doesNotThrow(() => validate(approved));
  assert.doesNotThrow(() => validate(approved, "ARTIST"));
});

test("rejects tracks without offline or mixing rights", () => {
  assert.throws(() => validate({ ...approved, distributionAllowed: false }), /rights do not cover/);
  assert.throws(() => validate({ ...approved, offlineAllowed: false }), /rights do not cover/);
  assert.throws(() => validate({ ...approved, mixAllowed: false }), /rights do not cover/);
});

test("development audio stays separate from licensed rights claims", () => {
  const { rightsHolder, rightsBasis, rightsEvidenceRef, distributionAllowed, offlineAllowed, mixAllowed, ...testAudio } = approved;
  assert.doesNotThrow(() => validate(testAudio, "DEVELOPMENT_TEST"));
  assert.throws(() => validate(approved, "DEVELOPMENT_TEST"), /cannot claim commercial rights/);
});

test("local inbox audio can enter with rights pending", () => {
  const { rightsHolder, rightsBasis, rightsEvidenceRef, distributionAllowed, offlineAllowed, mixAllowed, ...pending } = approved;
  assert.doesNotThrow(() => validate(pending, "LOCAL_IMPORT"));
  assert.throws(() => validate({ ...pending, distributionAllowed: "yes" as unknown as boolean }, "LOCAL_IMPORT"), /permissions must be booleans/);
});

test("independent artist submissions can wait for rights review", () => {
  const { rightsHolder, rightsBasis, rightsEvidenceRef, distributionAllowed, offlineAllowed, mixAllowed, ...pending } = approved;
  assert.doesNotThrow(() => validate(pending, "ARTIST"));
});

test("rejects missing evidence and expired rights", () => {
  assert.throws(() => validate({ ...approved, rightsEvidenceRef: "" }), /evidence reference/);
  assert.throws(() => validate({ ...approved, rightsExpiresAt: "2020-01-01T00:00:00Z" }), /rights expired/);
});

test("accepts bounded audio features and rejects invalid values", () => {
  assert.doesNotThrow(() => validate({ ...approved, bpm: 120, musicalKey: "A minor", energy: 0.7 }));
  assert.throws(() => validate({ ...approved, bpm: 500 }), /invalid BPM/);
  assert.throws(() => validate({ ...approved, energy: 1.5 }), /invalid energy/);
});

test("does not send provider credentials to another audio host", () => {
  assert.deepEqual(providerAudioHeaders("https://feed.example/catalog", "https://cdn.other.example/audio", "secret"), {});
  assert.deepEqual(providerAudioHeaders("https://feed.example/catalog", "https://feed.example/audio", "secret"),
    { Authorization: "Bearer secret" });
});
