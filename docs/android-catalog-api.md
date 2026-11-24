# Android catalogue synchronisation contract (v1)

The Android and Next.js projects are independent. This documents the existing public read API; it does not enable Android's currently disabled remote integration.

## `GET /api/catalog`

Returns `200` with a complete snapshot: `{ "schemaVersion": 1, "generatedAt": "<ISO-8601 UTC>", "tracks": [] }`. The array contains only published tracks whose distribution, offline-playback and mixing permissions are current, whose partner is verified, and whose latest rights review matches the imported audio and metadata. An empty array is valid. A database failure returns `503` with `{ "error": "Catalog unavailable" }`; clients must keep the last valid offline snapshot on such a failure.

Each track contains `id` (UUID), `title`, `artist`, `album`, `year`, `category`, `genre`, `language`, `durationMs`, `bpm`, `musicalKey`, `energy`, `rightsHolder`, `rightsBasis`, `attributionUrl`, `rightsExpiresAt`, `audioUrl`, `mimeType`, `bytes`, and `sha256`. Optional metadata uses JSON `null`. `rightsExpiresAt`, when present, is ISO-8601 UTC with milliseconds. Private agreement references, reviewer identities and evidence hashes are never included.

The Android v1 client accepts only HTTPS, follows no redirects, requires `schemaVersion === 1`, limits the response to 5 MiB and 5,000 tracks, and downloads at most ten new audio files per sync. It verifies UUIDs, MIME types, size, SHA-256 and that each `audioUrl` has the exact catalogue origin. A complete successful snapshot is authoritative: absent or expired tracks are removed from its managed offline library. The server must not return a partial snapshot as if it were complete.

## `GET /api/media/{id}`

Temporarily returns the same generic `404 Audio unavailable` response for every ID, including IDs present in the public catalogue. The response has `Cache-Control: private, no-store, max-age=0` and `X-Content-Type-Options: nosniff`. It does not query D1, read R2, stream audio, or permit offline downloads. Listener authentication and entitlements are mandatory before commercial audio delivery can be enabled. The existing `audioUrl` field remains in the v1 catalogue JSON for structural compatibility, but it is not currently playable. Clients must treat this phase as metadata-only and must not interpret catalogue visibility as permission to retrieve audio.

## Integration requirements

Set `PUBLIC_CATALOG_ORIGIN` to the backend's public HTTPS origin. Serve the API and media route on that same origin. The Android app's remote-catalog flag is currently disabled, so this document is a contract for the later integration phase. There is no public write or submission API. Artist and distributor files enter through trusted administrative imports.

The v1 API is a full snapshot without paging, delta tokens or conditional requests. Before a catalogue exceeds the Android limits, design a versioned v2 protocol and update both projects together. Keep remote audio sync disabled while this metadata-only safeguard is in place. A future audio contract must add verified listener identity, separate streaming and offline entitlements, expiry and revocation, and authorization on every audio request before commercial listener launch.
