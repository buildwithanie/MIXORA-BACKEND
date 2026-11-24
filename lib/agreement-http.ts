import { AgreementError } from "./agreements";
import { StaffAccessError } from "./staff-auth";

export const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export function agreementFailure(error: unknown): Response {
  if (error instanceof StaffAccessError) return new Response(error.message, {
    status: error.status, headers: privateHeaders });
  if (error instanceof AgreementError) return new Response(error.message, {
    status: error.status, headers: privateHeaders });
  // Do not echo D1, R2, token, bucket, or document details.
  return new Response("Agreement service unavailable", { status: 503, headers: privateHeaders });
}
