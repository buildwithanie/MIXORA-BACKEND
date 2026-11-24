import { publishedTracks } from "../../../lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function catalogOrigin(request: Request): string | null {
  const configured = process.env.PUBLIC_CATALOG_ORIGIN;
  if (process.env.NODE_ENV === "production" && !configured) return null;
  try {
    const url = new URL(configured || new URL(request.url).origin);
    if (!['http:', 'https:'].includes(url.protocol) ||
        (process.env.NODE_ENV === "production" && url.protocol !== "https:") ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const origin = catalogOrigin(request);
    if (!origin) {
      return Response.json({ error: "HTTPS catalog origin required" }, { status: 503 });
    }
    const tracks = (await publishedTracks()).map((row) => ({
      id: row.id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      year: row.release_year,
      category: row.category,
      genre: row.genre,
      language: row.language,
      durationMs: Number(row.duration_ms),
      bpm: row.bpm,
      musicalKey: row.musical_key,
      energy: row.energy,
      rightsHolder: row.rights_holder,
      rightsBasis: row.rights_basis,
      attributionUrl: row.attribution_url,
      rightsExpiresAt: row.rights_expires_at ? new Date(row.rights_expires_at).toISOString() : null,
      audioUrl: `${origin}/api/media/${row.id}`,
      mimeType: row.mime_type,
      bytes: Number(row.byte_size),
      sha256: row.sha256,
    }));
    return Response.json({ schemaVersion: 1, generatedAt: new Date().toISOString(), tracks }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Catalog query failed", error);
    return Response.json({ error: "Catalog unavailable" }, { status: 503 });
  }
}
