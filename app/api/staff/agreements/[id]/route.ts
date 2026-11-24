import { inspectAgreement } from "../../../../../lib/agreements";
import { agreementFailure, privateHeaders } from "../../../../../lib/agreement-http";
import { authorizeStaffRequestAny } from "../../../../../lib/staff-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const staff = await authorizeStaffRequestAny(request, ["PARTNER_VERIFIER", "AUDITOR"]);
    const agreement = await inspectAgreement((await context.params).id, staff);
    if (!agreement) return new Response("Agreement unavailable", { status: 404, headers: privateHeaders });
    const { object_key: _privateKey, ...metadata } = agreement;
    return Response.json(metadata, { headers: privateHeaders });
  } catch (error) { return agreementFailure(error); }
}
