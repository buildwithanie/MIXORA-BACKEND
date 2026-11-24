import { uploadAgreement } from "../../../../lib/agreements";
import type { AgreementInput } from "../../../../lib/agreements";
import { agreementFailure, privateHeaders } from "../../../../lib/agreement-http";
import { authorizeStaffRequest } from "../../../../lib/staff-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const maxBytes = 10 * 1024 * 1024;
const maxRequestBytes = maxBytes + 8192;

export async function POST(request: Request): Promise<Response> {
  try {
    const staff = await authorizeStaffRequest(request, "PARTNER_REGISTRAR");
    const length = Number(request.headers.get("Content-Length"));
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.startsWith("multipart/form-data; boundary=") ||
        !Number.isSafeInteger(length) || length < 8 || length > maxRequestBytes || !request.body) {
      return new Response("Multipart agreement upload required (10 MB PDF maximum)",
        { status: 400, headers: privateHeaders });
    }
    const reader = request.body.getReader();
    const chunks: Buffer[] = [];
    let count = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        if (count > maxRequestBytes || count > length) {
          await reader.cancel();
          return new Response("Agreement upload too large", { status: 400, headers: privateHeaders });
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    if (count !== length) return new Response("Incomplete agreement upload", { status: 400, headers: privateHeaders });
    let form: FormData;
    try {
      form = await new Request("http://localhost", {
        method: "POST", headers: { "Content-Type": contentType },
        body: new Uint8Array(Buffer.concat(chunks, count)),
      }).formData();
    } catch { return new Response("Invalid agreement upload", { status: 400, headers: privateHeaders }); }
    const metadata = form.get("metadata");
    const file = form.get("file");
    if (typeof metadata !== "string" || metadata.length > 4096 ||
        !(file instanceof File) || file.type !== "application/pdf" || file.size > maxBytes) {
      return new Response("Agreement metadata and PDF required", { status: 400, headers: privateHeaders });
    }
    let input: AgreementInput;
    try { input = JSON.parse(metadata) as AgreementInput; }
    catch { return new Response("Invalid agreement metadata", { status: 400, headers: privateHeaders }); }
    const agreementId = await uploadAgreement(input, Buffer.from(await file.arrayBuffer()),
      request.headers.get("X-Content-SHA256") ?? "", staff);
    return Response.json({ agreementId, verificationStatus: "PENDING" },
      { status: 201, headers: privateHeaders });
  } catch (error) { return agreementFailure(error); }
}
