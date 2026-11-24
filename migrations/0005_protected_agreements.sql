-- Stage 3: private legal documents. Additive; no existing catalogue rows or R2 objects change.
CREATE TABLE IF NOT EXISTS catalog_agreements (
  agreement_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES catalog_partners(partner_id),
  agreement_type TEXT NOT NULL CHECK (agreement_type IN ('ARTIST', 'DISTRIBUTOR', 'LABEL', 'ADDENDUM')),
  grantor TEXT NOT NULL CHECK (length(trim(grantor)) BETWEEN 2 AND 200),
  grantee TEXT NOT NULL CHECK (length(trim(grantee)) BETWEEN 2 AND 200),
  distribution_allowed INTEGER NOT NULL CHECK (distribution_allowed IN (0,1)),
  offline_allowed INTEGER NOT NULL CHECK (offline_allowed IN (0,1)),
  mix_allowed INTEGER NOT NULL CHECK (mix_allowed IN (0,1)),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  object_key TEXT NOT NULL UNIQUE CHECK (object_key LIKE 'agreements/%.pdf'),
  mime_type TEXT NOT NULL CHECK (mime_type='application/pdf'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 8 AND 10485760),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64),
  metadata_version TEXT NOT NULL CHECK (length(metadata_version)=64),
  uploaded_by_subject TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verification_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','REVOKED')),
  verified_by_subject TEXT,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS catalog_agreements_partner_idx
  ON catalog_agreements(partner_id, verification_status);

CREATE TABLE IF NOT EXISTS catalog_agreement_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  agreement_id TEXT NOT NULL REFERENCES catalog_agreements(agreement_id),
  action TEXT NOT NULL CHECK (action IN ('UPLOADED','INSPECTED','RETRIEVED','VERIFIED','REJECTED','REVOKED')),
  actor_subject TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 1000),
  recorded_at TEXT NOT NULL,
  metadata_version TEXT NOT NULL CHECK (length(metadata_version)=64),
  document_sha256 TEXT NOT NULL CHECK (length(document_sha256)=64),
  previous_hash TEXT NOT NULL CHECK (length(previous_hash)=64),
  event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash)=64),
  CHECK ((action='UPLOADED' AND actor_role='PARTNER_REGISTRAR')
      OR (action IN ('INSPECTED','RETRIEVED') AND actor_role IN ('PARTNER_VERIFIER','AUDITOR'))
      OR (action IN ('VERIFIED','REJECTED') AND actor_role='PARTNER_VERIFIER')
      OR (action='REVOKED' AND actor_role='REVOKER'))
);
CREATE INDEX IF NOT EXISTS catalog_agreement_events_agreement_idx
  ON catalog_agreement_events(agreement_id, event_seq);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_agreement_events_previous_idx
  ON catalog_agreement_events(previous_hash);

CREATE TRIGGER IF NOT EXISTS catalog_agreement_events_insert_guard
BEFORE INSERT ON catalog_agreement_events
BEGIN
  SELECT CASE WHEN NEW.previous_hash <> COALESCE(
    (SELECT event_hash FROM catalog_agreement_events ORDER BY event_seq DESC LIMIT 1),
    '0000000000000000000000000000000000000000000000000000000000000000')
    THEN RAISE(ABORT, 'agreement audit chain changed') END;
  SELECT CASE WHEN strftime('%s',NEW.recorded_at) IS NULL
    OR abs(strftime('%s','now')-strftime('%s',NEW.recorded_at)) > 300
    THEN RAISE(ABORT, 'agreement audit timestamp invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalog_staff_roles s WHERE s.subject=NEW.actor_subject
      AND s.role=NEW.actor_role AND s.enabled=1
      AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now')))
    THEN RAISE(ABORT, 'active staff role required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalog_agreements a WHERE a.agreement_id=NEW.agreement_id
      AND a.metadata_version=NEW.metadata_version AND a.sha256=NEW.document_sha256
      AND (NEW.action<>'UPLOADED' OR a.uploaded_by_subject=NEW.actor_subject)
      AND (NEW.action NOT IN ('VERIFIED','REJECTED') OR
        (a.verification_status='PENDING' AND a.uploaded_by_subject<>NEW.actor_subject))
      AND (NEW.action<>'REVOKED' OR a.verification_status='VERIFIED'))
    THEN RAISE(ABORT, 'agreement snapshot or duties invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_agreement_events_decision_projection
AFTER INSERT ON catalog_agreement_events
WHEN NEW.action IN ('VERIFIED','REJECTED','REVOKED')
BEGIN
  UPDATE catalog_agreements SET verification_status=NEW.action,
    verified_by_subject=NEW.actor_subject, verified_at=NEW.recorded_at
    WHERE agreement_id=NEW.agreement_id;
END;
CREATE TRIGGER IF NOT EXISTS catalog_agreement_events_immutable_update
BEFORE UPDATE ON catalog_agreement_events
BEGIN SELECT RAISE(ABORT, 'agreement audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_agreement_events_immutable_delete
BEFORE DELETE ON catalog_agreement_events
BEGIN SELECT RAISE(ABORT, 'agreement audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_agreements_immutable_delete
BEFORE DELETE ON catalog_agreements
BEGIN SELECT RAISE(ABORT, 'agreement records are retained'); END;
CREATE TRIGGER IF NOT EXISTS catalog_agreements_metadata_guard
BEFORE UPDATE ON catalog_agreements
WHEN NEW.partner_id<>OLD.partner_id OR NEW.agreement_type<>OLD.agreement_type
  OR NEW.grantor<>OLD.grantor OR NEW.grantee<>OLD.grantee
  OR NEW.distribution_allowed<>OLD.distribution_allowed
  OR NEW.offline_allowed<>OLD.offline_allowed OR NEW.mix_allowed<>OLD.mix_allowed
  OR NEW.valid_from<>OLD.valid_from
  OR coalesce(NEW.valid_until,'')<>coalesce(OLD.valid_until,'')
  OR NEW.object_key<>OLD.object_key OR NEW.mime_type<>OLD.mime_type
  OR NEW.byte_size<>OLD.byte_size OR NEW.sha256<>OLD.sha256
  OR NEW.metadata_version<>OLD.metadata_version
  OR NEW.uploaded_by_subject<>OLD.uploaded_by_subject
  OR NEW.uploaded_at<>OLD.uploaded_at
BEGIN SELECT RAISE(ABORT, 'agreement metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_agreements_status_guard
BEFORE UPDATE ON catalog_agreements
WHEN NEW.verification_status<>OLD.verification_status
  OR coalesce(NEW.verified_by_subject,'')<>coalesce(OLD.verified_by_subject,'')
  OR coalesce(NEW.verified_at,'')<>coalesce(OLD.verified_at,'')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalog_agreement_events e WHERE e.agreement_id=OLD.agreement_id
      AND e.event_seq=(SELECT max(event_seq) FROM catalog_agreement_events
        WHERE agreement_id=OLD.agreement_id)
      AND e.action=NEW.verification_status
      AND e.actor_subject=NEW.verified_by_subject
      AND e.recorded_at=NEW.verified_at
      AND e.metadata_version=OLD.metadata_version
      AND e.document_sha256=OLD.sha256)
    THEN RAISE(ABORT, 'agreement decision audit required') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_agreement_revoke_partner
AFTER INSERT ON catalog_agreement_events WHEN NEW.action='REVOKED'
BEGIN
  UPDATE catalog_partners SET status='SUSPENDED', review_status='REVOKED',
    updated_at=CURRENT_TIMESTAMP
    WHERE partner_id=(SELECT partner_id FROM catalog_agreements WHERE agreement_id=NEW.agreement_id)
      AND agreement_ref=NEW.agreement_id AND status='VERIFIED';
  UPDATE catalog_tracks SET published=0, updated_at=CURRENT_TIMESTAMP
    WHERE provider_id=(SELECT partner_id FROM catalog_agreements WHERE agreement_id=NEW.agreement_id)
      AND published=1 AND EXISTS (
        SELECT 1 FROM catalog_partners p WHERE p.partner_id=catalog_tracks.provider_id
          AND p.agreement_ref=NEW.agreement_id);
END;

CREATE TRIGGER IF NOT EXISTS catalog_publish_agreement_guard
BEFORE UPDATE ON catalog_tracks WHEN NEW.published=1
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM catalog_partners p JOIN catalog_agreements a
      ON a.agreement_id=p.agreement_ref AND a.partner_id=p.partner_id
    WHERE p.partner_id=NEW.provider_id AND p.status='VERIFIED'
      AND p.review_status='APPROVED' AND a.verification_status='VERIFIED'
      AND a.sha256=p.agreement_sha256
      AND a.distribution_allowed=1 AND a.offline_allowed=1 AND a.mix_allowed=1
      AND a.valid_from<=date('now') AND (a.valid_until IS NULL OR a.valid_until>=date('now')))
    THEN RAISE(ABORT, 'verified private agreement required') END;
END;

