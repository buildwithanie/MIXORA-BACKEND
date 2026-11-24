-- Stage 2: additive, append-only review audit. Existing rows remain untouched.
ALTER TABLE catalog_partners ADD COLUMN submitted_by_subject TEXT;
ALTER TABLE catalog_partners ADD COLUMN submission_fingerprint TEXT;
ALTER TABLE catalog_partners ADD COLUMN review_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (review_status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED'));
ALTER TABLE catalog_tracks ADD COLUMN submitted_by_subject TEXT;
ALTER TABLE catalog_rights_reviews ADD COLUMN audit_event_id TEXT;

CREATE TABLE IF NOT EXISTS catalog_review_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('PARTNER', 'TRACK')),
  entity_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'REVOKED', 'SOURCE_WITHDRAWN')),
  actor_subject TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 1000),
  recorded_at TEXT NOT NULL,
  metadata_version TEXT NOT NULL CHECK (length(metadata_version) = 64),
  audio_sha256 TEXT CHECK (audio_sha256 IS NULL OR length(audio_sha256) = 64),
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR length(evidence_sha256) = 64),
  agreement_sha256 TEXT CHECK (agreement_sha256 IS NULL OR length(agreement_sha256) = 64),
  agreement_ref TEXT,
  rights_evidence_ref TEXT,
  submitted_by_subject TEXT,
  previous_hash TEXT NOT NULL CHECK (length(previous_hash) = 64),
  event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 64),
  CHECK ((entity_type='PARTNER' AND decision IN ('APPROVED','REJECTED') AND actor_role='PARTNER_VERIFIER')
    OR (entity_type='PARTNER' AND decision='REVOKED' AND actor_role='REVOKER')
    OR (entity_type='TRACK' AND decision IN ('APPROVED','REJECTED') AND actor_role='RIGHTS_REVIEWER')
    OR (entity_type='TRACK' AND decision='REVOKED' AND actor_role='REVOKER')
    OR (entity_type='TRACK' AND decision='SOURCE_WITHDRAWN' AND actor_role='SYSTEM'
      AND actor_subject='system:provider-sync')),
  CHECK (decision='SOURCE_WITHDRAWN' OR evidence_sha256 IS NOT NULL),
  CHECK (entity_type='PARTNER' OR audio_sha256 IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS catalog_review_events_entity_idx
  ON catalog_review_events (entity_type, entity_id, event_seq);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_review_events_previous_idx
  ON catalog_review_events (previous_hash);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_reviews_audit_event_idx
  ON catalog_rights_reviews (audit_event_id) WHERE audit_event_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS catalog_review_events_insert_guard
BEFORE INSERT ON catalog_review_events
BEGIN
  SELECT CASE WHEN NEW.previous_hash <> COALESCE(
    (SELECT event_hash FROM catalog_review_events ORDER BY event_seq DESC LIMIT 1),
    '0000000000000000000000000000000000000000000000000000000000000000')
    THEN RAISE(ABORT, 'audit chain head changed') END;
  SELECT CASE WHEN abs(strftime('%s','now') - strftime('%s',NEW.recorded_at)) > 300
    OR strftime('%s',NEW.recorded_at) IS NULL
    THEN RAISE(ABORT, 'audit timestamp invalid') END;
  SELECT CASE WHEN NEW.decision <> 'SOURCE_WITHDRAWN' AND NOT EXISTS (
    SELECT 1 FROM catalog_staff_roles s WHERE s.subject=NEW.actor_subject
      AND s.role=NEW.actor_role AND s.enabled=1
      AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now')))
    THEN RAISE(ABORT, 'active staff role required') END;
  SELECT CASE WHEN NEW.entity_type='PARTNER' AND NOT EXISTS (
    SELECT 1 FROM catalog_partners p WHERE p.partner_id=NEW.entity_id
      AND p.partner_id=NEW.partner_id AND p.submission_fingerprint=NEW.metadata_version
      AND p.submitted_by_subject=NEW.submitted_by_subject
      AND (NEW.decision='REVOKED' OR (p.submitted_by_subject IS NOT NULL
        AND p.submitted_by_subject<>NEW.actor_subject))
      AND ((NEW.decision IN ('APPROVED','REJECTED') AND p.status='PENDING'
        AND p.review_status='PENDING')
        OR (NEW.decision='REVOKED' AND p.status='VERIFIED')))
    THEN RAISE(ABORT, 'partner review snapshot or duties invalid') END;
  SELECT CASE WHEN NEW.entity_type='TRACK' AND NOT EXISTS (
    SELECT 1 FROM catalog_tracks t WHERE t.id=NEW.entity_id
      AND t.provider_id=NEW.partner_id AND t.import_fingerprint=NEW.metadata_version
      AND t.sha256=NEW.audio_sha256
      AND coalesce(t.rights_evidence_ref,'')=coalesce(NEW.rights_evidence_ref,'')
      AND (NEW.decision IN ('REVOKED','SOURCE_WITHDRAWN')
        OR (t.submitted_by_subject IS NOT NULL
          AND t.submitted_by_subject=NEW.submitted_by_subject
          AND t.submitted_by_subject<>NEW.actor_subject))
      AND (NEW.decision<>'APPROVED' OR (t.development_only=0
        AND t.distribution_allowed=1 AND t.offline_allowed=1 AND t.mix_allowed=1
        AND length(trim(coalesce(t.rights_holder,'')))>0 AND t.rights_basis IS NOT NULL
        AND length(trim(coalesce(t.rights_evidence_ref,'')))>0
        AND (t.rights_expires_at IS NULL OR datetime(t.rights_expires_at)>datetime('now'))
        AND EXISTS (SELECT 1 FROM catalog_partners p WHERE p.partner_id=t.provider_id
          AND p.status='VERIFIED' AND p.review_status='APPROVED'
          AND p.verified_by<>NEW.actor_subject
          AND p.submitted_by_subject<>NEW.actor_subject
          AND p.agreement_sha256=NEW.agreement_sha256
          AND ((t.source_type='ARTIST' AND p.kind='ARTIST')
            OR (t.source_type='PROVIDER' AND p.kind IN ('DISTRIBUTOR','LABEL'))
            OR t.source_type='LOCAL_IMPORT')))))
    THEN RAISE(ABORT, 'track review snapshot or duties invalid') END;
END;

CREATE TRIGGER IF NOT EXISTS catalog_review_events_partner_projection
AFTER INSERT ON catalog_review_events WHEN NEW.entity_type='PARTNER'
BEGIN
  UPDATE catalog_partners SET
    status=CASE WHEN NEW.decision='APPROVED' THEN 'VERIFIED'
      WHEN NEW.decision='REVOKED' THEN 'SUSPENDED' ELSE status END,
    review_status=NEW.decision,
    agreement_ref=CASE WHEN NEW.decision='APPROVED' THEN NEW.agreement_ref ELSE agreement_ref END,
    agreement_sha256=CASE WHEN NEW.decision='APPROVED' THEN NEW.agreement_sha256 ELSE agreement_sha256 END,
    verified_by=CASE WHEN NEW.decision='APPROVED' THEN NEW.actor_subject ELSE verified_by END,
    verified_at=CASE WHEN NEW.decision='APPROVED' THEN NEW.recorded_at ELSE verified_at END,
    updated_at=CURRENT_TIMESTAMP
  WHERE partner_id=NEW.entity_id;
END;

CREATE TRIGGER IF NOT EXISTS catalog_review_events_track_projection
AFTER INSERT ON catalog_review_events WHEN NEW.entity_type='TRACK'
BEGIN
  INSERT INTO catalog_rights_reviews
    (track_id, decision, reviewer_id, evidence_sha256, import_fingerprint,
      audio_sha256, rights_evidence_ref, reviewed_at, audit_event_id)
  VALUES (NEW.entity_id,
    CASE WHEN NEW.decision='APPROVED' THEN 'APPROVED' ELSE 'REVOKED' END,
    NEW.actor_subject, NEW.evidence_sha256, NEW.metadata_version,
    NEW.audio_sha256, coalesce(NEW.rights_evidence_ref,''), NEW.recorded_at, NEW.event_id);
  UPDATE catalog_tracks SET published=0, updated_at=CURRENT_TIMESTAMP
    WHERE id=NEW.entity_id AND NEW.decision<>'APPROVED' AND published=1;
END;

CREATE TRIGGER IF NOT EXISTS catalog_reviews_new_insert_guard
BEFORE INSERT ON catalog_rights_reviews
BEGIN
  SELECT CASE WHEN NEW.audit_event_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM catalog_review_events e WHERE e.event_id=NEW.audit_event_id
      AND e.entity_type='TRACK' AND e.entity_id=NEW.track_id
      AND e.actor_subject=NEW.reviewer_id AND e.metadata_version=NEW.import_fingerprint
      AND e.audio_sha256=NEW.audio_sha256
      AND ((e.decision='APPROVED' AND NEW.decision='APPROVED')
        OR (e.decision<>'APPROVED' AND NEW.decision='REVOKED')))
    THEN RAISE(ABORT, 'audit event required for review') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_reviews_immutable_update
BEFORE UPDATE ON catalog_rights_reviews BEGIN SELECT RAISE(ABORT, 'review history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_reviews_immutable_delete
BEFORE DELETE ON catalog_rights_reviews BEGIN SELECT RAISE(ABORT, 'review history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_events_immutable_update
BEFORE UPDATE ON catalog_review_events BEGIN SELECT RAISE(ABORT, 'audit history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_events_immutable_delete
BEFORE DELETE ON catalog_review_events BEGIN SELECT RAISE(ABORT, 'audit history is immutable'); END;