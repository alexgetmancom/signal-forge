import { timingSafeEqual } from "node:crypto";

/** Compares without leaking the answer through response time. */
function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function bearerTokenAccepted(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  return safeEqual(authorization.slice("Bearer ".length), expected);
}
