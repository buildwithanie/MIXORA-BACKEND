-- MIXORA catalogue metadata for Cloudflare D1 (SQLite). Audio bytes live in private R2.
CREATE TABLE IF NOT EXISTS catalog_tracks (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    release_year INTEGER CHECK (release_year IS NULL OR release_year BETWEEN 1900 AND 2100),
    category TEXT NOT NULL CHECK (category IN ('ANY', 'GOSPEL', 'BONGO', 'SECULAR', 'WORSHIP')),
    genre TEXT,
    language TEXT NOT NULL CHECK (language IN ('UNKNOWN', 'SWAHILI', 'ENGLISH', 'KIKUYU')),
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    bpm INTEGER CHECK (bpm IS NULL OR bpm BETWEEN 40 AND 240),
    musical_key TEXT,
    energy REAL CHECK (energy IS NULL OR energy BETWEEN 0 AND 1),
    rights_holder TEXT,
    rights_basis TEXT CHECK (rights_basis IS NULL OR rights_basis IN ('CC_BY', 'CC0', 'PUBLIC_DOMAIN', 'DIRECT_LICENSE', 'LABEL_CONTRACT')),
    rights_evidence_ref TEXT,
    attribution_url TEXT,
    distribution_allowed INTEGER NOT NULL DEFAULT 0 CHECK (distribution_allowed IN (0, 1)),
    offline_allowed INTEGER NOT NULL DEFAULT 0 CHECK (offline_allowed IN (0, 1)),
    mix_allowed INTEGER NOT NULL DEFAULT 0 CHECK (mix_allowed IN (0, 1)),
    rights_expires_at TEXT,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    import_fingerprint TEXT,
    source_type TEXT NOT NULL DEFAULT 'PROVIDER' CHECK (source_type IN ('PROVIDER', 'ARTIST', 'LOCAL_IMPORT', 'DEVELOPMENT_TEST')),
    source_feed_url TEXT,
    development_only INTEGER NOT NULL DEFAULT 0 CHECK (development_only IN (0, 1)),
    artwork_storage_key TEXT,
    artwork_mime_type TEXT,
    artwork_byte_size INTEGER,
    artwork_sha256 TEXT,
    published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, external_id),
    CHECK (development_only = (source_type = 'DEVELOPMENT_TEST')),
    CHECK (published = 0 OR (
        source_type IN ('PROVIDER', 'ARTIST', 'LOCAL_IMPORT')
        AND development_only = 0
        AND distribution_allowed = 1 AND offline_allowed = 1 AND mix_allowed = 1
        AND length(trim(coalesce(rights_holder, ''))) > 0
        AND rights_basis IS NOT NULL
        AND (rights_basis <> 'CC_BY' OR (attribution_url IS NOT NULL AND attribution_url LIKE 'https://%'))
        AND length(trim(coalesce(rights_evidence_ref, ''))) > 0
    ))
);

CREATE INDEX IF NOT EXISTS catalog_tracks_public_idx ON catalog_tracks (published, rights_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_development_sha256_idx
    ON catalog_tracks (sha256) WHERE source_type = 'DEVELOPMENT_TEST';
CREATE UNIQUE INDEX IF NOT EXISTS catalog_local_import_sha256_idx
    ON catalog_tracks (sha256) WHERE source_type = 'LOCAL_IMPORT';
