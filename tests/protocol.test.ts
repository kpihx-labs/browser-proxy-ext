import { expect, test } from "bun:test";
import { createProof } from "../src/crypto";
import { parseServerMessage, serializeClientMessage } from "../src/protocol";

/**
 * Purpose: verify acceptance of exactly valid server protocol frames.
 * Args: none.
 * Returns: a promise resolving after protocol assertions complete.
 * Examples: accepts an authentication frame; accepts a unique snapshot-scope request.
 */
async function acceptsValidFrames(): Promise<void> {
  expect(parseServerMessage('{"type":"authenticated"}')).toEqual({ type: "authenticated" });
  expect(parseServerMessage('{"type":"requestSnapshot","requestId":"r-1","scopes":["tabs","bookmarks"]}')).toEqual({ type: "requestSnapshot", requestId: "r-1", scopes: ["tabs", "bookmarks"] });
}

/**
 * Purpose: verify rejection of malformed, extended, and unsafe protocol frames.
 * Args: none.
 * Returns: a promise resolving after rejection assertions complete.
 * Examples: rejects JSON arrays; rejects duplicate scopes.
 */
async function rejectsInvalidFrames(): Promise<void> {
  expect(parseServerMessage("[]")).toBeNull();
  expect(parseServerMessage('{"type":"authenticated","extra":true}')).toBeNull();
  expect(parseServerMessage('{"type":"requestSnapshot","requestId":"r-1","scopes":["tabs","tabs"]}')).toBeNull();
}

/**
 * Purpose: verify deterministic client JSON serialization.
 * Args: none.
 * Returns: a promise resolving after serialization assertions complete.
 * Examples: serializes hello; serializes a request denial.
 */
async function serializesClientFrames(): Promise<void> {
  expect(serializeClientMessage({ type: "hello", protocolVersion: 1, extensionVersion: "0.1.0" })).toBe('{"type":"hello","protocolVersion":1,"extensionVersion":"0.1.0"}');
  expect(serializeClientMessage({ type: "requestDenied", requestId: "r-1" })).toBe('{"type":"requestDenied","requestId":"r-1"}');
}

/**
 * Purpose: verify HMAC proof generation against an independently known SHA-256 test vector.
 * Args: none.
 * Returns: a promise resolving after the digest assertion completes.
 * Examples: proves `key` and `The quick brown fox...`; proves a secret is not returned verbatim.
 */
async function createsHmacProof(): Promise<void> {
  expect(await createProof("key", "The quick brown fox jumps over the lazy dog")).toBe("97yD9DBThCSxMpjmqm-xQ-9NWaFJRhdZl0edvC0aPNg");
  expect(await createProof("0123456789abcdef", "nonce-123456789012")).not.toContain("0123456789abcdef");
}

test("accepts valid protocol frames", acceptsValidFrames);
test("rejects invalid protocol frames", rejectsInvalidFrames);
test("serializes client protocol frames", serializesClientFrames);
test("creates non-secret HMAC proofs", createsHmacProof);
