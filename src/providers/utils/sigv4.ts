// AWS Signature Version 4 signing implementation for Bedrock API calls.
// Uses Node.js built-in crypto module – zero external dependencies.

import { createHmac, createHash } from "crypto";

export type SigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type SigV4Request = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
};

/**
 * Signs an HTTP request using AWS Signature Version 4.
 * Returns a new headers object with the Authorization, x-amz-date,
 * and optionally x-amz-security-token headers added.
 */
export function signRequest(req: SigV4Request): Record<string, string> {
  const now = new Date();
  const dateStamp = toDateStamp(now);
  const amzDate = toAmzDate(now);

  const parsed = new URL(req.url);
  const host = parsed.host;
  const canonicalUri = parsed.pathname || "/";
  const canonicalQuerystring = sortQueryParams(parsed.searchParams);

  // Build headers to sign
  const headers: Record<string, string> = {
    ...req.headers,
    host,
    "x-amz-date": amzDate,
  };

  if (req.credentials.sessionToken) {
    headers["x-amz-security-token"] = req.credentials.sessionToken;
  }

  // Canonical headers (must be sorted, lowercased)
  const signedHeaderKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[Object.keys(headers).find((h) => h.toLowerCase() === k)!]?.trim()}`)
    .join("\n") + "\n";
  const signedHeaders = signedHeaderKeys.join(";");

  // Payload hash
  const payloadHash = sha256(req.body);

  // Canonical request
  const canonicalRequest = [
    req.method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // Credential scope
  const credentialScope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;

  // String to sign
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  // Signing key
  const signingKey = getSignatureKey(
    req.credentials.secretAccessKey,
    dateStamp,
    req.region,
    req.service,
  );

  // Signature
  const signature = hmacHex(signingKey, stringToSign);

  // Authorization header
  const authorization = `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const result: Record<string, string> = {
    ...req.headers,
    "x-amz-date": amzDate,
    Authorization: authorization,
  };

  if (req.credentials.sessionToken) {
    result["x-amz-security-token"] = req.credentials.sessionToken;
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDateStamp(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 8);
}

function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function sortQueryParams(params: URLSearchParams): string {
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
