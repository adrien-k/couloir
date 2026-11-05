import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare untrusted input to a secret without leaking length or content via timing.
 * Both sides are hashed so timingSafeEqual always sees equal-length buffers.
 */
export function secretsEqual(a, b) {
  const left = createHash("sha256")
    .update(String(a ?? ""), "utf8")
    .digest();
  const right = createHash("sha256")
    .update(String(b ?? ""), "utf8")
    .digest();
  return timingSafeEqual(left, right);
}
