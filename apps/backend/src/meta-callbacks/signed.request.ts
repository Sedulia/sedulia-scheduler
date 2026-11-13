import { createHmac, timingSafeEqual } from 'crypto';

// Meta's signed_request: "<base64url signature>.<base64url payload>", the signature being HMAC-SHA256 of the
// payload part exactly as received, keyed with the app secret. The payload is JSON with the algorithm,
// the issue time in seconds and the app scoped user id.
// https://developers.facebook.com/docs/games/gamesonfacebook/login#parsingsr

export type SignedRequestFailure =
  | 'malformed'
  | 'no_secret'
  | 'algorithm'
  | 'signature'
  | 'stale';

export class SignedRequestError extends Error {
  constructor(public readonly reason: SignedRequestFailure) {
    super(`signed_request refused: ${reason}`);
  }
}

// Meta sends a callback as it happens. An hour covers a retry and clock drift; a request older than that,
// or issued in the future, is refused.
export const MAX_AGE_SECONDS = 60 * 60;
export const MAX_FUTURE_SECONDS = 5 * 60;
const MAX_LENGTH = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const USER_ID = /^[0-9]{1,32}$/;

export function verifySignedRequest(
  signedRequest: unknown,
  secret: string | undefined,
  nowMs = Date.now()
): { userId: string; issuedAt: number } {
  if (!secret) {
    throw new SignedRequestError('no_secret');
  }
  if (typeof signedRequest !== 'string' || !signedRequest || signedRequest.length > MAX_LENGTH) {
    throw new SignedRequestError('malformed');
  }
  const parts = signedRequest.split('.');
  if (parts.length !== 2 || !parts.every((p) => p && BASE64URL.test(p))) {
    throw new SignedRequestError('malformed');
  }
  const [signaturePart, payloadPart] = parts;

  // the signature is over the encoded payload part as it arrived, never over the decoded JSON
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  const given = Buffer.from(signaturePart, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new SignedRequestError('signature');
  }

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw new SignedRequestError('malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SignedRequestError('malformed');
  }

  if (payload.algorithm !== 'HMAC-SHA256') {
    throw new SignedRequestError('algorithm');
  }

  const issuedAt = payload.issued_at;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)) {
    throw new SignedRequestError('malformed');
  }
  const age = Math.floor(nowMs / 1000) - issuedAt;
  if (age > MAX_AGE_SECONDS || age < -MAX_FUTURE_SECONDS) {
    throw new SignedRequestError('stale');
  }

  const userId = payload.user_id; // Meta sends it as a string; a number could have lost digits
  if (typeof userId !== 'string' || !USER_ID.test(userId)) {
    throw new SignedRequestError('malformed');
  }
  return { userId, issuedAt };
}
