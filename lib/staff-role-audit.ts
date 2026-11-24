import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { requireStaffAdmin } from "./staff-admin";
import type { StaffAdminPrincipal } from "./staff-admin";
import { staffRoles } from "./staff-auth";
import type { StaffRole } from "./staff-auth";

export type StaffRoleAction = "GRANTED" | "DISABLED" | "EXPIRY_CHANGED";
type RoleRow = { enabled: number; expires_at: string | null };
type RoleEvent = {
  event_id: string; action: StaffRoleAction; actor_subject: string;
  target_subject: string; role: StaffRole; before_enabled: number | null;
  after_enabled: number; before_expires_at: string | null; after_expires_at: string | null;
  reason: string; evidence_sha256: string; recorded_at: string;
  previous_hash: string; event_hash: string;
};
const genesis = "0".repeat(64);
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/i;
const fields = ["event_id", "action", "actor_subject", "target_subject", "role",
  "before_enabled", "after_enabled", "before_expires_at", "after_expires_at",
  "reason", "evidence_sha256", "recorded_at", "previous_hash", "event_hash"] as const;

function digest(event: Omit<RoleEvent, "event_hash">): string {
  const key = process.env.MIXORA_AUDIT_HMAC_KEY ?? "";
  if (!sha256.test(key)) throw new Error("MIXORA audit HMAC key is not configured");
  return createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify([
    "mixora-staff-role-v1", event.event_id, event.action, event.actor_subject,
    event.target_subject, event.role, event.before_enabled, event.after_enabled,
    event.before_expires_at, event.after_expires_at, event.reason,
    event.evidence_sha256, event.recorded_at, event.previous_hash,
  ])).digest("hex");
}

function expiry(value: string | null): boolean {
  return value === null || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() ===
      (value.includes(".") ? value : value.replace("Z", ".000Z")));
}

export async function changeStaffRole(action: StaffRoleAction, target: string, role: StaffRole,
  expiresAt: string | null, evidenceSha256: string, reason: string,
  admin: StaffAdminPrincipal): Promise<boolean> {
  const actor = requireStaffAdmin(admin);
  if (!["GRANTED", "DISABLED", "EXPIRY_CHANGED"].includes(action) ||
      !uuid.test(target) || target === actor || !staffRoles.includes(role) ||
      !expiry(expiresAt) || !sha256.test(evidenceSha256) ||
      typeof reason !== "string" || reason.trim().length < 8 || reason.length > 1000) {
    throw new Error("Invalid staff role change");
  }
  const existing = await db().query<RoleRow>(
    "SELECT enabled, expires_at FROM catalog_staff_roles WHERE subject=$1 AND role=$2",
    [target, role]);
  const before = existing.rows[0] ?? null;
  if ((action === "GRANTED" && before?.enabled === 1) ||
      (action !== "GRANTED" && !before) ||
      (action === "DISABLED" && before?.enabled !== 1) ||
      (action === "EXPIRY_CHANGED" && before?.expires_at === expiresAt) ||
      (action === "GRANTED" && expiresAt && Date.parse(expiresAt) <= Date.now())) return false;
  const afterEnabled = action === "DISABLED" ? 0 : action === "GRANTED" ? 1 : before!.enabled;
  const afterExpiry = action === "DISABLED" ? before!.expires_at : expiresAt;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await db().query<{ event_hash: string }>(
      "SELECT event_hash FROM catalog_staff_role_events ORDER BY event_seq DESC LIMIT 1");
    const unsigned = {
      event_id: randomUUID(), action, actor_subject: actor, target_subject: target, role,
      before_enabled: before?.enabled ?? null, after_enabled: afterEnabled,
      before_expires_at: before?.expires_at ?? null, after_expires_at: afterExpiry,
      reason: reason.trim(), evidence_sha256: evidenceSha256.toLowerCase(),
      recorded_at: new Date().toISOString(), previous_hash: head.rows[0]?.event_hash ?? genesis,
    };
    const event: RoleEvent = { ...unsigned, event_hash: digest(unsigned) };
    const result = await db().query<{ event_id: string }>(
      "INSERT INTO catalog_staff_role_events (" + fields.join(",") + ") SELECT " +
        fields.map((_, index) => "$" + (index + 1)).join(",") +
        " WHERE COALESCE((SELECT event_hash FROM catalog_staff_role_events " +
        "ORDER BY event_seq DESC LIMIT 1),'" + genesis + "')=$13 RETURNING event_id",
      fields.map((field) => event[field]));
    if (result.rows.length) return true;
  }
  throw new Error("Staff role audit changed during administration; retry later");
}

export async function verifyStaffRoleAuditHistory(): Promise<number> {
  const history = await db().query<RoleEvent>(
    "SELECT " + fields.join(",") + " FROM catalog_staff_role_events ORDER BY event_seq");
  let previous = genesis;
  const current = new Map<string, RoleEvent>();
  for (const event of history.rows) {
    if (event.previous_hash !== previous || !sha256.test(event.event_hash)) {
      throw new Error("Staff role audit chain mismatch");
    }
    const { event_hash: _stored, ...unsigned } = event;
    const expected = digest(unsigned);
    if (!timingSafeEqual(Buffer.from(event.event_hash, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("Staff role audit signature mismatch");
    }
    current.set(event.target_subject + ":" + event.role, event);
    previous = event.event_hash;
  }
  for (const event of current.values()) {
    const row = await db().query<RoleRow>(
      "SELECT enabled, expires_at FROM catalog_staff_roles WHERE subject=$1 AND role=$2",
      [event.target_subject, event.role]);
    if (!row.rows[0] || Number(row.rows[0].enabled) !== Number(event.after_enabled) ||
        row.rows[0].expires_at !== event.after_expires_at) {
      throw new Error("Staff role projection mismatch");
    }
  }
  return history.rows.length;
}
