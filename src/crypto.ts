/**
 * Purpose: derive a base64url HMAC-SHA-256 proof without exposing a shared secret to page code.
 * Args: `secret` is the extension-stored secret; `nonce` is the daemon challenge.
 * Returns: a base64url HMAC digest suitable for the `authenticate` protocol message.
 * Examples: `createProof("secret", "nonce-123456789012")`; `createProof("another-secret", "challenge-abcdefgh")`.
 */
export async function createProof(secret: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(nonce));
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Purpose: encode binary data as URL-safe base64 without padding.
 * Args: `bytes` is the binary digest to encode.
 * Returns: a base64url string.
 * Examples: `toBase64Url(new Uint8Array([255]))` returns `_w`; `toBase64Url(new Uint8Array())` returns `""`.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
