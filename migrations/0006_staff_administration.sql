-- Additive staff-administration audit. Existing role rows and review chains are unchanged.
-- A trusted D1 operator must provision the first administrator in catalog_staff_admins.
CREATE TABLE IF NOT EXISTS catalog_staff_admins (
  subject TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  expires_at TEXT,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_staff_role_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('GRANTED','DISABLED','EXPIRY_CHANGED')),
  actor_subject TEXT NOT NULL,
  target_subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN
    ('PARTNER_REGISTRAR','PARTNER_VERIFIER','RIGHTS_REVIEWER','PUBLISHER','REVOKER','AUDITOR')),
  before_enabled INTEGER CHECK (before_enabled IS NULL OR before_enabled IN (0,1)),
  after_enabled INTEGER NOT NULL CHECK (after_enabled IN (0,1)),
  before_expires_at TEXT,
  after_expires_at TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 1000),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64),
  recorded_at TEXT NOT NULL,
  previous_hash TEXT NOT NULL CHECK (length(previous_hash)=64),
  event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash)=64),
  CHECK (actor_subject<>target_subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_staff_role_events_previous_idx
  ON catalog_staff_role_events(previous_hash);
CREATE INDEX IF NOT EXISTS catalog_staff_role_events_target_idx
  ON catalog_staff_role_events(target_subject, role, event_seq);

CREATE TRIGGER IF NOT EXISTS catalog_staff_role_events_guard
BEFORE INSERT ON catalog_staff_role_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalog_staff_admins a WHERE a.subject=NEW.actor_subject
      AND a.enabled=1 AND (a.expires_at IS NULL OR datetime(a.expires_at)>datetime('now')))
    THEN RAISE(ABORT, 'active staff administrator required') END;
  SELECT CASE WHEN NEW.previous_hash<>COALESCE(
    (SELECT event_hash FROM catalog_staff_role_events ORDER BY event_seq DESC LIMIT 1),
    '0000000000000000000000000000000000000000000000000000000000000000')
    THEN RAISE(ABORT, 'staff role audit head changed') END;
  SELECT CASE WHEN strftime('%s',NEW.recorded_at) IS NULL OR
      abs(strftime('%s','now')-strftime('%s',NEW.recorded_at))>300
    THEN RAISE(ABORT, 'staff role audit timestamp invalid') END;
  SELECT CASE WHEN NEW.action='GRANTED' AND NOT (
    NEW.after_enabled=1 AND
    ((NEW.before_enabled IS NULL AND NOT EXISTS (
      SELECT 1 FROM catalog_staff_roles WHERE subject=NEW.target_subject AND role=NEW.role))
     OR (NEW.before_enabled=0 AND EXISTS (
      SELECT 1 FROM catalog_staff_roles WHERE subject=NEW.target_subject AND role=NEW.role
        AND enabled=0 AND coalesce(expires_at,'')=coalesce(NEW.before_expires_at,'')))))
    THEN RAISE(ABORT, 'staff grant state changed') END;
  SELECT CASE WHEN NEW.action='DISABLED' AND NOT (
    NEW.before_enabled=1 AND NEW.after_enabled=0 AND
    coalesce(NEW.before_expires_at,'')=coalesce(NEW.after_expires_at,'') AND EXISTS (
      SELECT 1 FROM catalog_staff_roles WHERE subject=NEW.target_subject AND role=NEW.role
        AND enabled=1 AND coalesce(expires_at,'')=coalesce(NEW.before_expires_at,'')))
    THEN RAISE(ABORT, 'staff disable state changed') END;
  SELECT CASE WHEN NEW.action='EXPIRY_CHANGED' AND NOT (
    NEW.before_enabled=NEW.after_enabled AND
    coalesce(NEW.before_expires_at,'')<>coalesce(NEW.after_expires_at,'') AND EXISTS (
      SELECT 1 FROM catalog_staff_roles WHERE subject=NEW.target_subject AND role=NEW.role
        AND enabled=NEW.before_enabled
        AND coalesce(expires_at,'')=coalesce(NEW.before_expires_at,'')))
    THEN RAISE(ABORT, 'staff expiry state changed') END;
END;

CREATE TRIGGER IF NOT EXISTS catalog_staff_role_events_grant
AFTER INSERT ON catalog_staff_role_events WHEN NEW.action='GRANTED'
BEGIN
  INSERT INTO catalog_staff_roles (subject,role,enabled,expires_at,granted_by,granted_at)
  VALUES (NEW.target_subject,NEW.role,1,NEW.after_expires_at,NEW.actor_subject,NEW.recorded_at)
  ON CONFLICT(subject,role) DO UPDATE SET enabled=1, expires_at=excluded.expires_at,
    granted_by=excluded.granted_by, granted_at=excluded.granted_at;
END;
CREATE TRIGGER IF NOT EXISTS catalog_staff_role_events_disable
AFTER INSERT ON catalog_staff_role_events WHEN NEW.action='DISABLED'
BEGIN
  UPDATE catalog_staff_roles SET enabled=0 WHERE subject=NEW.target_subject AND role=NEW.role;
END;
CREATE TRIGGER IF NOT EXISTS catalog_staff_role_events_expiry
AFTER INSERT ON catalog_staff_role_events WHEN NEW.action='EXPIRY_CHANGED'
BEGIN
  UPDATE catalog_staff_roles SET expires_at=NEW.after_expires_at
    WHERE subject=NEW.target_subject AND role=NEW.role;
END;
CREATE TRIGGER IF NOT EXISTS catalog_staff_role_events_immutable_update
BEFORE UPDATE ON catalog_staff_role_events
BEGIN SELECT RAISE(ABORT,'staff role audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_staff_role_events_immutable_delete
BEFORE DELETE ON catalog_staff_role_events
BEGIN SELECT RAISE(ABORT,'staff role audit is immutable'); END;

-- Existing grants are grandfathered. Future role mutations require the latest
-- event, whose projection runs atomically in the same INSERT statement.
CREATE TRIGGER IF NOT EXISTS catalog_staff_roles_audited_insert
BEFORE INSERT ON catalog_staff_roles
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalog_staff_role_events e
    WHERE e.target_subject=NEW.subject AND e.role=NEW.role
      AND e.action='GRANTED' AND e.after_enabled=NEW.enabled
      AND coalesce(e.after_expires_at,'')=coalesce(NEW.expires_at,'')
      AND e.actor_subject=NEW.granted_by AND e.recorded_at=NEW.granted_at
      AND e.event_seq=(SELECT max(event_seq) FROM catalog_staff_role_events
        WHERE target_subject=NEW.subject AND role=NEW.role))
    THEN RAISE(ABORT,'staff role audit event required') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_staff_roles_audited_update
BEFORE UPDATE ON catalog_staff_roles
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalog_staff_role_events e
    WHERE e.target_subject=NEW.subject AND e.role=NEW.role
      AND e.before_enabled=OLD.enabled AND e.after_enabled=NEW.enabled
      AND coalesce(e.before_expires_at,'')=coalesce(OLD.expires_at,'')
      AND coalesce(e.after_expires_at,'')=coalesce(NEW.expires_at,'')
      AND ((e.action='GRANTED' AND e.actor_subject=NEW.granted_by
        AND e.recorded_at=NEW.granted_at)
        OR (e.action IN ('DISABLED','EXPIRY_CHANGED')
          AND NEW.granted_by=OLD.granted_by AND NEW.granted_at=OLD.granted_at))
      AND e.event_seq=(SELECT max(event_seq) FROM catalog_staff_role_events
        WHERE target_subject=NEW.subject AND role=NEW.role))
    THEN RAISE(ABORT,'staff role audit event required') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_staff_roles_audited_delete
BEFORE DELETE ON catalog_staff_roles
BEGIN SELECT RAISE(ABORT,'staff role history is retained'); END;
