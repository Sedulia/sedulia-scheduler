// A mailed set-password or reset link must never act as a session. Run from the repository root:
//   pnpm exec jest -c apps/backend/jest.config.cjs apps/backend/src/services/auth

jest.mock('@gitroom/nestjs-libraries/database/prisma/organizations/organization.service', () => ({ OrganizationService: class {} }));
jest.mock('@gitroom/nestjs-libraries/database/prisma/users/users.service', () => ({ UsersService: class {} }));
jest.mock('@gitroom/nestjs-libraries/chat/mastra.service', () => ({ MastraService: class {} }));
jest.mock('@gitroom/nestjs-libraries/sentry/initialize.sentry', () => ({ setSentryUserContext: () => undefined }));
jest.mock('@gitroom/nestjs-libraries/services/exception.filter', () => ({
  HttpForbiddenException: class HttpForbiddenException extends Error {},
}));

import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { signResetToken } from '@gitroom/backend/services/auth/reset.token';

const run = async (token: string) => {
  const getUserById = jest.fn(async () => ({ id: 'u1', activated: true, isSuperAdmin: false, password: 'x' }));
  const orgs = { getOrgsByUserId: jest.fn(async () => [{ id: 'o1', apiKey: 'k', users: [{ disabled: false }], subscription: null }]) };
  const mw = new AuthMiddleware(orgs as any, { getUserById } as any);
  const next = jest.fn();
  const req: any = { headers: { auth: token }, cookies: {} };
  const res: any = { header: jest.fn(), cookie: jest.fn() };
  let error: any = null;
  try {
    await mw.use(req, res, next);
  } catch (e) {
    error = e;
  }
  return { error, next, getUserById };
};

beforeEach(() => {
  process.env.JWT_SECRET = 'a-test-jwt-secret-that-is-long-enough';
  process.env.FRONTEND_URL = 'https://social.example';
});

describe('AuthMiddleware and reset tokens', () => {
  it('refuses a reset token without reading the user: new shape, and upstream shape', async () => {
    for (const token of [
      signResetToken({ id: 'u1', password: '' }, '2999-01-01 00:00:00'),
      AuthChecker.signJWT({ id: 'u1', expires: '2999-01-01 00:00:00' }),
    ]) {
      const { error, next, getUserById } = await run(token);
      expect(error).not.toBeNull();
      expect(next).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
    }
  });

  it('still admits an ordinary session token (the refusal is not a blanket one)', async () => {
    const { error, getUserById } = await run(AuthChecker.signJWT({ id: 'u1', email: 'a@b.example' }));
    expect(error).toBeNull();
    expect(getUserById).toHaveBeenCalledWith('u1');
  });
});
