-- Additive production review records. Existing catalog_tracks and audio objects are preserved.
CREATE TABLE IF NOT EXISTS catalog_partners (
    partner_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('ARTIST', 'DISTRIBUTOR', 'LABEL')),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'SUSPENDED')),
    agreement_ref TEXT,
    agreement_sha256 TEXT CHECK (agreement_sha256 IS NULL OR length(agreement_sha256) = 64),
    verified_by TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status <> 'VERIFIED' OR (length(trim(coalesce(agreement_ref, ''))) > 0
        AND agreement_sha256 IS NOT NULL AND length(trim(coalesce(verified_by, ''))) > 0
        AND verified_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS catalog_rights_reviews (
    review_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL REFERENCES catalog_tracks(id),
    decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REVOKED')),
    reviewer_id TEXT NOT NULL CHECK (length(trim(reviewer_id)) > 0),
    evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR length(evidence_sha256) = 64),
    import_fingerprint TEXT NOT NULL,
    audio_sha256 TEXT NOT NULL,
    rights_evidence_ref TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (decision <> 'APPROVED' OR evidence_sha256 IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS catalog_reviews_track_idx ON catalog_rights_reviews (track_id, review_seq);

CREATE TRIGGER IF NOT EXISTS catalog_publish_insert_guard
BEFORE INSERT ON catalog_tracks WHEN NEW.published = 1
BEGIN
    SELECT RAISE(ABORT, 'review approval required');
END;

CREATE TRIGGER IF NOT EXISTS catalog_publish_update_guard
BEFORE UPDATE ON catalog_tracks WHEN NEW.published = 1
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM catalog_rights_reviews r
        JOIN catalog_partners p ON p.partner_id = NEW.provider_id
        WHERE r.track_id = NEW.id AND r.decision = 'APPROVED'
          AND r.review_seq = (SELECT max(review_seq) FROM catalog_rights_reviews WHERE track_id = NEW.id)
          AND r.import_fingerprint = NEW.import_fingerprint AND r.audio_sha256 = NEW.sha256
          AND r.rights_evidence_ref = NEW.rights_evidence_ref
          AND p.status = 'VERIFIED'
          AND ((NEW.source_type = 'ARTIST' AND p.kind = 'ARTIST')
            OR (NEW.source_type = 'PROVIDER' AND p.kind IN ('DISTRIBUTOR', 'LABEL'))
            OR (NEW.source_type = 'LOCAL_IMPORT'))
    ) THEN RAISE(ABORT, 'review approval required') END;
END;
