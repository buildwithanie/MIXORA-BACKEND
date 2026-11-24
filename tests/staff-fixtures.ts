import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AccessConfig } from "../lib/staff-auth";

export const config: AccessConfig = {
  issuer: "https://mixora-test.cloudflareaccess.com",
  audience: "a".repeat(64),
};
export const humanSubject = "55555555-5555-4555-8555-555555555555";

export async function staffFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "local-test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = async (claims: Record<string, unknown> = {}, expiration: string | number = "5m",
    subject: string = humanSubject, overrides: { issuer?: string; audience?: string } = {}) => new SignJWT({
    type: "app", email: "staff@example.test", ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
    .setIssuer(overrides.issuer ?? config.issuer).setAudience(overrides.audience ?? config.audience).setSubject(subject)
    .setIssuedAt().setExpirationTime(expiration).sign(privateKey);
  return { keys, jwk, sign };
}
