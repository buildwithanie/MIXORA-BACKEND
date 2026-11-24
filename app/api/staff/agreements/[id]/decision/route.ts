import { decideAgreement } from "../../../../../../lib/agreements";
import { agreementFailure, privateHeaders } from "../../../../../../lib/agreement-http";
import { authorizeStaffRequestAny } from "../../../../../../lib/staff-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const staff = await authorizeStaffRequestAny(request, ["PARTNER_VERIFIER", "REVOKER"]);
    const length = Number(request.headers.get("Content-Length"));
    if (!Number.isSafeInteger(length) || length < 1 || length > 2048) {
      return new Response("Decision body required", { status: 400, headers: privateHeaders });
    }
    if (!request.body) return new Response("Invalid decision", { status: 400, headers: privateHeaders });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2048 || size > length) {
          await reader.cancel();
          return new Response("Invalid decision", { status: 400, headers: privateHeaders });
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (size !== length) return new Response("Invalid decision", { status: 400, headers: privateHeaders });
    let body: { decision?: string; reason?: string };
    try { body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as typeof body; }
    catch { return new Response("Invalid decision", { status: 400, headers: privateHeaders }); }
    if (!["VERIFIED", "REJECTED", "REVOKED"].includes(body.decision ?? "") ||
        typeof body.reason !== "string") {
      return new Response("Invalid decision", { status: 400, headers: privateHeaders });
    }
    const changed = await decideAgreement((await context.params).id,
      body.decision as "VERIFIED" | "REJECTED" | "REVOKED", body.reason, staff);
    if (!changed) return new Response("Agreement decision not allowed", { status: 409, headers: privateHeaders });
    return Response.json({ decision: body.decision }, { headers: privateHeaders });
  } catch (error) { return agreementFailure(error); }
}

