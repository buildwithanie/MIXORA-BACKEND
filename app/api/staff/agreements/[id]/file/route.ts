import { retrieveAgreement } from "../../../../../../lib/agreements";
import { agreementFailure, privateHeaders } from "../../../../../../lib/agreement-http";
import { authorizeStaffRequestAny } from "../../../../../../lib/staff-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const staff = await authorizeStaffRequestAny(request, ["PARTNER_VERIFIER", "AUDITOR"]);
    const id = (await context.params).id;
    const document = await retrieveAgreement(id, staff);
    if (!document) return new Response("Agreement unavailable", { status: 404, headers: privateHeaders });
    return new Response(new Uint8Array(document), { headers: {
      ...privateHeaders, "Content-Type": "application/pdf",
      "Content-Length": String(document.length),
      "Content-Disposition": 'attachment; filename="agreement-' + id + '.pdf"',
      "Content-Security-Policy": "sandbox",
    } });
  } catch (error) { return agreementFailure(error); }
}
