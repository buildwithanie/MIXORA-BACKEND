-- Role grants are provisioned only after a human Cloudflare Access identity is verified.
CREATE TABLE IF NOT EXISTS catalog_staff_roles (
    subject TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('PARTNER_REGISTRAR', 'PARTNER_VERIFIER', 'RIGHTS_REVIEWER', 'PUBLISHER', 'REVOKER', 'AUDITOR')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    granted_by TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    PRIMARY KEY (subject, role)
);
CREATE INDEX IF NOT EXISTS catalog_staff_roles_active_idx ON catalog_staff_roles (subject, enabled, expires_at);
