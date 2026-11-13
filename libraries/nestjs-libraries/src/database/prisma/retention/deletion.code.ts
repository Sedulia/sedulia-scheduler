import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

// The confirmation code of a deletion request (Meta's data deletion callback, and a workspace closure).
// It is an opaque, URL safe token that names what it is about, so the status page needs no table:
//   code = base64url( iv(12) | tag(16) | AES-256-GCM(JSON {k, r, i}) )
//   k: 'p' a person's request (r is the network's app scoped user id), 'w' a workspace closure (r is its id)
//   i: the issue time in seconds
// The payload is encrypted, so the address carries no identifier, and GCM authenticates it, so a code that
// was not issued here, or was changed by one bit, fails to open. The key is derived from JWT_SECRET under
// its own label, so the code is never valid as anything else and no new secret name exists.

export const DELETION_CODE_LABEL = 'sedulia.deletion-status.v1';
export type DeletionKind = 'person' | 'workspace';
export interface DeletionRef {
  kind: DeletionKind;
  ref: string;
  issuedAt: number;
}

const KIND_CODE = { person: 'p', workspace: 'w' } as const;
const MAX_CODE_LENGTH = 512;
const IV = 12;
const TAG = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const key = (): Buffer => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), DELETION_CODE_LABEL, 32));
};

export function issueDeletionCode(kind: DeletionKind, ref: string, now = new Date()): string {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const sealed = Buffer.concat([
    cipher.update(
      JSON.stringify({ k: KIND_CODE[kind], r: ref, i: Math.floor(now.getTime() / 1000) }),
      'utf8'
    ),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/** The request a code names, or null for anything that was not issued here (never throws). */
export function readDeletionCode(code: unknown): DeletionRef | null {
  try {
    if (typeof code !== 'string' || !code || code.length > MAX_CODE_LENGTH || !BASE64URL.test(code)) {
      return null;
    }
    const raw = Buffer.from(code, 'base64url');
    if (raw.length <= IV + TAG) {
      return null;
    }
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, IV));
    decipher.setAuthTag(raw.subarray(IV, IV + TAG));
    const body = JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(IV + TAG)), decipher.final()]).toString('utf8')
    );
    const kind = body?.k === 'p' ? 'person' : body?.k === 'w' ? 'workspace' : null;
    if (
      !kind ||
      typeof body.r !== 'string' ||
      !body.r ||
      body.r.length > 200 ||
      !Number.isSafeInteger(body.i)
    ) {
      return null;
    }
    return { kind, ref: body.r, issuedAt: body.i };
  } catch {
    return null;
  }
}
