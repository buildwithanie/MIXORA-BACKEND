export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Commercial audio stays unavailable until listener identity and entitlements exist.
// Do not inspect the track ID or touch D1/R2: every request gets the same answer.
export async function GET(_request: Request, _context: { params: Promise<{ id: string }> }): Promise<Response> {
  return new Response("Audio unavailable", {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
