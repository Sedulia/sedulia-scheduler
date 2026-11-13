import { createHash } from 'crypto';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';

// A password reset (or first set-password) token is NOT a session. Upstream signed {id, expires} with the same key as the
// login token, so the session middleware, which only reads `id`, accepted a mailed link as a login that never expired.
//  * It carries kind "reset", so AuthMiddleware refuses it (isResetToken) and nothing but forgotReturn reads it.
//  * It carries a fingerprint of the password the user has right now (pw), so the link works once: the moment the password
//    changes, every earlier link for that user is dead.
export const RESET_KIND = 'reset';

export const passwordFingerprint = (password?: string | null) =>
  createHash('sha256').update('reset:' + (password || '')).digest('hex').slice(0, 32);

export const signResetToken = (user: { id: string; password?: string | null }, expires: string) =>
  AuthChecker.signJWT({ kind: RESET_KIND, id: user.id, expires, pw: passwordFingerprint(user.password) });

// Any token with `expires` or kind reset is a reset token, whatever else it carries (upstream's old shape included).
export const isResetToken = (payload: unknown) =>
  !!payload && typeof payload === 'object' && ('expires' in (payload as object) || (payload as { kind?: unknown }).kind === RESET_KIND);
