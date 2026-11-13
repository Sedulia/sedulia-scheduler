// Sign-in under closed registration (DISABLE_REGISTRATION=true): the gate every provider goes through.
// Prisma is mocked by an in-memory user model under the real UsersRepository; the mail transport is a stub.
// Nothing here opens a database, runs prisma generate or db push.
// Run from the repository root:  pnpm exec jest -c apps/backend/jest.config.cjs apps/backend/src/services/auth

jest.mock('@gitroom/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/users/users.service', () => {
  // The real service is a thin pass through to the repository; the repository below is the real one.
  return {
    UsersService: class {
      constructor(private _r: any) {}
      getUserByEmail(email: string) {
        return this._r.getUserByEmail(email);
      }
      getUserById(id: string) {
        return this._r.getUserById(id);
      }
      getUserByProvider(id: string, provider: any) {
        return this._r.getUserByProvider(id, provider);
      }
      updatePassword(id: string, password: string) {
        return this._r.updatePassword(id, password);
      }
    },
  };
});
jest.mock('@gitroom/nestjs-libraries/newsletter/newsletter.service', () => ({
  NewsletterService: { register: jest.fn(async () => undefined) },
}));
jest.mock('@gitroom/nestjs-libraries/services/email.service', () => ({ EmailService: class {} }));
jest.mock('@gitroom/backend/services/auth/providers/providers.manager', () => ({ AuthProviderManager: class {} }));

import { Provider } from '@prisma/client';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { signResetToken } from '@gitroom/backend/services/auth/reset.token';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// ---- the mocked Prisma: an in-memory user model -------------------------------------------------------------------

class FakeUserModel {
  rows: any[] = [];
  async findFirst({ where }: any) {
    return (
      this.rows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          // honours what the repository asks for: insensitive only when it says mode insensitive
          (where.email === undefined ||
            (where.email.mode === 'insensitive'
              ? r.email.toLowerCase() === String(where.email.equals).toLowerCase()
              : r.email === where.email.equals)) &&
          (where.providerName === undefined || r.providerName === where.providerName) &&
          (where.providerId === undefined || r.providerId === where.providerId) &&
          (where.deletedAt === undefined || r.deletedAt === where.deletedAt)
      ) ?? null
    );
  }
  async update({ where, data }: any) {
    const row = this.rows.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return row;
  }
}

const user = (over: any = {}) => ({
  id: 'u-' + Math.random().toString(36).slice(2),
  email: 'owner@paid.example',
  password: '',
  providerName: 'LOCAL',
  providerId: '',
  isSuperAdmin: false,
  activated: true,
  deletedAt: null,
  ...over,
});

const PROVIDER_USERS: Record<string, { id: string; email: string }> = {
  'google-ok': { id: 'g-1', email: 'Owner@Paid.example' },
  'google-stranger': { id: 'g-2', email: 'stranger@nowhere.example' },
  'apple-ok': { id: 'a-1', email: 'owner@paid.example' },
  'apple-stranger': { id: 'a-2', email: 'stranger@nowhere.example' },
  'generic-stranger': { id: 'x-1', email: 'stranger@nowhere.example' },
};

function build() {
  const users = new FakeUserModel();
  const orgs: any[] = [];
  const repo = new UsersRepository({ model: { user: users } } as any, {} as any);
  const userService: any = new (UsersService as any)(repo);
  const organizationService = {
    getCount: jest.fn(async () => orgs.length),
    createOrgAndUser: jest.fn(async (body: any) => {
      const u = user({ email: body.email, providerName: body.provider, providerId: body.providerId || '' });
      users.rows.push(u);
      orgs.push({ id: 'o-' + orgs.length });
      return { id: 'o-new', users: [{ user: u }] };
    }),
    addUserToOrg: jest.fn(async () => false),
  };
  const emailService = {
    sendEmailSync: jest.fn(async () => undefined),
    sendEmail: jest.fn(async () => undefined),
    hasProvider: () => true,
  };
  const providerManager = {
    getProvider: (name: string) => ({
      getToken: async (code: string) => code,
      getUser: async (token: string) => PROVIDER_USERS[token] ?? false,
      generateLink: () => 'https://provider.example/auth',
      name,
    }),
  };
  const auth = new AuthService(userService, organizationService as any, emailService as any, providerManager as any);
  return { auth, users, orgs, organizationService, emailService };
}

const ENV = ['DISABLE_REGISTRATION', 'POSTIZ_GENERIC_OAUTH', 'JWT_SECRET', 'FRONTEND_URL', 'DISALLOW_PLUS'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  process.env.DISABLE_REGISTRATION = 'true';
  process.env.JWT_SECRET = 'a-test-jwt-secret-that-is-long-enough';
  process.env.FRONTEND_URL = 'https://social.example';
  delete process.env.POSTIZ_GENERIC_OAUTH;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const signIn = (auth: AuthService, provider: Provider, token: string) =>
  auth.routeAuth(provider, { providerToken: token, company: 'x' } as any, '1.2.3.4', 'jest');

// ---- Google and Apple: only an address that already has a user -------------------------------------------------------

describe.each([
  ['GOOGLE', 'google-ok', 'google-stranger'],
  ['APPLE', 'apple-ok', 'apple-stranger'],
])('%s sign in with registration closed', (provider, okToken, strangerToken) => {
  it('signs in an address that already has a user, matched without regard to case, and creates nothing', async () => {
    const { auth, users, orgs, organizationService } = build();
    const owner = user();
    users.rows.push(owner);

    const out = await signIn(auth, provider as Provider, okToken);

    const jwt: any = AuthChecker.verifyJWT(out.jwt);
    expect(jwt.id).toBe(owner.id);
    expect(jwt.isSuperAdmin).toBe(false);
    expect(jwt.password || '').toBe(''); // never a hash
    expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    expect(orgs).toHaveLength(0);
    expect(users.rows).toHaveLength(1);
  });

  it('refuses any other address and creates neither a user nor an organization', async () => {
    const { auth, users, orgs, organizationService } = build();
    users.rows.push(user());
    orgs.push({ id: 'o-existing' });

    await expect(signIn(auth, provider as Provider, strangerToken)).rejects.toThrow('Registration is disabled');

    expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    expect(orgs).toHaveLength(1);
    expect(users.rows).toHaveLength(1);
  });

  it('refuses an uninvited address even when the database has no organization at all', async () => {
    const { auth, users, orgs, organizationService } = build();

    await expect(signIn(auth, provider as Provider, strangerToken)).rejects.toThrow('Registration is disabled');

    expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    expect(orgs).toHaveLength(0);
    expect(users.rows).toHaveLength(0);
  });

  it('refuses a user whose account was closed (deletedAt set)', async () => {
    const { auth, users, organizationService } = build();
    users.rows.push(user({ deletedAt: new Date() }));

    await expect(signIn(auth, provider as Provider, okToken)).rejects.toThrow('Registration is disabled');
    expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
  });

  it('the first leg of the sign in (checkExists) logs an invited address straight in and refuses a stranger', async () => {
    const { auth, users, organizationService } = build();
    process.env.NOT_SECURED = 'true';
    try {
      users.rows.push(user());

      const ok: any = await auth.checkExists(provider, okToken, 'https://x/redirect');
      expect(ok.token).toBeUndefined();
      expect(AuthChecker.verifyJWT(ok.jwt)).toMatchObject({ email: 'owner@paid.example' });

      await expect(auth.checkExists(provider, strangerToken, 'https://x/redirect')).rejects.toThrow(
        'Registration is disabled'
      );
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    } finally {
      delete process.env.NOT_SECURED;
    }
  });
});

// ---- LOCAL and GENERIC, and the upstream allowance for an empty database ---------------------------------------------

describe('LOCAL and GENERIC registration with registration closed', () => {
  const dto = { email: 'Stranger@Nowhere.example', password: 'longenough', company: 'Acme', provider: 'LOCAL' };
  const register = async (auth: AuthService) => {
    const { CreateOrgUserDto } = await import('@gitroom/nestjs-libraries/dtos/auth/create.org.user.dto');
    return auth.routeAuth(Provider.LOCAL, Object.assign(new CreateOrgUserDto(), dto), '1.2.3.4', 'jest');
  };

  it('refuses LOCAL registration of an uninvited address when organizations exist', async () => {
    const { auth, orgs, organizationService } = build();
    orgs.push({ id: 'o-1' });
    await expect(register(auth)).rejects.toThrow('Registration is disabled');
    expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
  });

  it('refuses LOCAL registration with ZERO organizations: no first-user allowance', async () => {
    const { auth, orgs, organizationService } = build();
    expect(orgs).toHaveLength(0);
    await expect(register(auth)).rejects.toThrow('Registration is disabled');
    expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
  });

  it.each([['LOCAL'], ['GOOGLE'], ['APPLE'], ['GENERIC'], ['GITHUB']])(
    'canRegister(%s) is false with zero organizations and false with organizations',
    async (provider) => {
      const { auth, orgs, organizationService } = build();
      expect(await auth.canRegister(provider)).toBe(false);
      orgs.push({ id: 'o-1' });
      expect(await auth.canRegister(provider)).toBe(false);
      // the organization count is no longer an input to the answer at all
      expect(organizationService.getCount).not.toHaveBeenCalled();
    }
  );

  it('refuses a GENERIC sign in of a stranger even with POSTIZ_GENERIC_OAUTH set; the variable changes nothing', async () => {
    const { auth, orgs, organizationService } = build();
    for (const value of [undefined, '1', 'true', 'https://idp.example']) {
      if (value === undefined) delete process.env.POSTIZ_GENERIC_OAUTH;
      else process.env.POSTIZ_GENERIC_OAUTH = value;
      await expect(signIn(auth, Provider.GENERIC, 'generic-stranger')).rejects.toThrow('Registration is disabled');
    }
    expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    expect(orgs).toHaveLength(0);
  });

  it.each([['GITHUB'], ['GENERIC'], ['WALLET'], ['FARCASTER']])(
    '%s never signs an address in by its email, even one that has a user: only Google and Apple vouch for an address',
    async (provider) => {
      const { auth, users, organizationService } = build();
      users.rows.push(user({ email: 'stranger@nowhere.example' }));
      await expect(signIn(auth, provider as Provider, 'generic-stranger')).rejects.toThrow('Registration is disabled');
      await expect(auth.checkExists(provider, 'generic-stranger', 'https://x/redirect')).rejects.toThrow('Registration is disabled');
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    }
  );

  it('leaves registration as upstream when DISABLE_REGISTRATION is not true (the switch still works)', async () => {
    const { auth } = build();
    process.env.DISABLE_REGISTRATION = 'false';
    expect(await auth.canRegister('LOCAL')).toBe(true);
    delete process.env.DISABLE_REGISTRATION;
    expect(await auth.canRegister('GOOGLE')).toBe(true);
  });
});

// ---- email set-password and reset ---------------------------------------------------------------------------------------

describe('forgot password', () => {
  it('sends the reset by the synchronous path (sendEmailSync), never the Temporal queue', async () => {
    const { auth, users, emailService } = build();
    const owner = user();
    users.rows.push(owner);

    await auth.forgot('owner@paid.example');

    expect(emailService.sendEmailSync).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    const [to, subject, html] = (emailService.sendEmailSync.mock.calls as any[][])[0];
    expect(to).toBe('owner@paid.example');
    expect(subject).toBe('Reset your password');
    const token = /\/auth\/forgot\/([^"]+)"/.exec(html)![1];
    expect(AuthChecker.verifyJWT(token)).toMatchObject({ id: owner.id });
  });

  it('sends nothing for an address that has no user', async () => {
    const { auth, emailService } = build();
    await auth.forgot('stranger@nowhere.example');
    expect(emailService.sendEmailSync).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  const FUTURE = '2999-01-01 00:00:00';
  const reset = (auth: AuthService, token: string, password = 'a brand new one') =>
    auth.forgotReturn({ token, password, repeatPassword: password } as any);

  it('a set-password link sets the first password of an owner made with none, and the owner can then sign in', async () => {
    const { auth, users } = build();
    const owner = user({ password: '' });
    users.rows.push(owner);

    expect(await reset(auth, signResetToken(owner, FUTURE))).toBeTruthy();

    expect(owner.password).not.toBe('');
    const out = await auth.routeAuth(Provider.LOCAL, { email: owner.email, password: 'a brand new one' } as any, '1.2.3.4', 'jest');
    expect(AuthChecker.verifyJWT(out.jwt)).toMatchObject({ id: owner.id });
  });

  it('a link works once: after the password is set the same link, and any older one, is dead', async () => {
    const { auth, users } = build();
    const owner = user({ password: '' });
    users.rows.push(owner);
    const first = signResetToken(owner, FUTURE);
    const second = signResetToken(owner, FUTURE);

    expect(await reset(auth, first)).toBeTruthy();
    const afterFirst = owner.password;
    expect(await reset(auth, first, 'attacker chosen')).toBe(false);
    expect(await reset(auth, second, 'attacker chosen')).toBe(false);
    expect(owner.password).toBe(afterFirst);
  });

  it('refuses an expired link, and a link for a user whose account was closed', async () => {
    const { auth, users } = build();
    const owner = user({ password: '' });
    users.rows.push(owner);
    expect(await reset(auth, signResetToken(owner, '2001-01-01 00:00:00'))).toBe(false);
    owner.deletedAt = new Date();
    expect(await reset(auth, signResetToken(owner, FUTURE))).toBe(false);
    expect(owner.password).toBe('');
  });

  it('refuses a session token, the old {id, expires} shape with no kind, a malformed expiry and garbage', async () => {
    const { auth, users } = build();
    const owner = user({ password: '' });
    users.rows.push(owner);
    const session = AuthChecker.signJWT({ id: owner.id, email: owner.email, isSuperAdmin: false, activated: true });
    const legacy = AuthChecker.signJWT({ id: owner.id, expires: FUTURE });
    const noExpiry = AuthChecker.signJWT({ kind: 'reset', id: owner.id, pw: 'x' });
    const badExpiry = AuthChecker.signJWT({ kind: 'reset', id: owner.id, pw: 'x', expires: 'soon' });
    for (const token of [session, legacy, noExpiry, badExpiry, 'not.a.jwt', '']) {
      expect(await reset(auth, token, 'attacker chosen')).toBe(false);
    }
    expect(owner.password).toBe('');
  });

  it('a reset link is refused by the session middleware: it cannot act as a login', async () => {
    const { isResetToken } = await import('@gitroom/backend/services/auth/reset.token');
    const owner = user({ password: '' });
    expect(isResetToken(AuthChecker.verifyJWT(signResetToken(owner, FUTURE)))).toBe(true);
    expect(isResetToken(AuthChecker.verifyJWT(AuthChecker.signJWT({ id: owner.id, expires: FUTURE })))).toBe(true); // upstream shape
    expect(isResetToken(AuthChecker.verifyJWT(AuthChecker.signJWT({ id: owner.id, email: owner.email })))).toBe(false); // a session
  });
});

// ---- the providers themselves: the address must be verified ------------------------------------------------------------

describe('provider verified address', () => {
  afterEach(() => jest.resetModules());

  it('Google refuses an address Google has not verified', async () => {
    jest.resetModules();
    jest.doMock('googleapis', () => {
      const get = jest.fn();
      const info = jest.fn();
      const google: any = {};
      Object.assign(google, {
          auth: { OAuth2: class { setCredentials() {} getTokenInfo = (...a: any[]) => google.__info(...a); } },
          oauth2: () => ({ userinfo: { get } }),
          __get: get,
          __info: info,
      });
      return { google };
    });
    const { google } = require('googleapis');
    const { GoogleProvider } = require('@gitroom/backend/services/auth/providers/google.provider');
    const provider = new GoogleProvider();
    process.env.YOUTUBE_CLIENT_ID = 'our-client-id';
    google.__info.mockResolvedValue({ aud: 'our-client-id' });

    google.__get.mockResolvedValueOnce({ data: { id: '1', email: 'a@b.example', verified_email: false } });
    await expect(provider.getUser('t')).rejects.toThrow('not verified');

    google.__get.mockResolvedValueOnce({ data: { id: '1', email: 'a@b.example', verified_email: true } });
    await expect(provider.getUser('t')).resolves.toEqual({ id: '1', email: 'a@b.example' });
  });

  it('Google refuses an access token issued to any other app, before it reads the profile', async () => {
    jest.resetModules();
    jest.doMock('googleapis', () => {
      const get = jest.fn();
      const info = jest.fn();
      const google: any = {};
      Object.assign(google, {
        auth: { OAuth2: class { setCredentials() {} getTokenInfo = (...a: any[]) => google.__info(...a); } },
        oauth2: () => ({ userinfo: { get } }),
        __get: get,
        __info: info,
      });
      return { google };
    });
    const { google } = require('googleapis');
    const { GoogleProvider } = require('@gitroom/backend/services/auth/providers/google.provider');
    const provider = new GoogleProvider();
    google.__get.mockResolvedValue({ data: { id: '1', email: 'owner@paid.example', verified_email: true } });

    process.env.YOUTUBE_CLIENT_ID = 'our-client-id';
    google.__info.mockResolvedValueOnce({ aud: 'some-other-site.apps.googleusercontent.com' });
    await expect(provider.getUser('replayed')).rejects.toThrow('not issued to this app');
    expect(google.__get).not.toHaveBeenCalled();

    delete process.env.YOUTUBE_CLIENT_ID; // an unset client id must not match an undefined audience
    google.__info.mockResolvedValueOnce({ aud: undefined });
    await expect(provider.getUser('t')).rejects.toThrow('not issued to this app');
    delete process.env.YOUTUBE_CLIENT_ID;
  });

  it('Apple refuses an address Apple has not verified', async () => {
    jest.resetModules();
    process.env.APPLE_CLIENT_ID = 'c';
    process.env.APPLE_TEAM_ID = 't';
    process.env.APPLE_KEY_ID = 'k';
    process.env.APPLE_PRIVATE_KEY = 'p';
    const claims: any = { sub: 'a-1', email: 'a@b.example', email_verified: 'false' };
    jest.doMock('jsonwebtoken', () => ({
      decode: () => ({ header: { kid: 'k1' } }),
      verify: () => claims,
      sign: () => 's',
    }));
    jest.doMock('crypto', () => ({ ...jest.requireActual('crypto'), createPublicKey: () => ({}) }));
    const realFetch = global.fetch;
    global.fetch = (async () => ({ json: async () => ({ keys: [{ kid: 'k1' }] }) })) as any;
    try {
      const { AppleProvider } = require('@gitroom/backend/services/auth/providers/apple.provider');
      const provider = new AppleProvider();
      await expect(provider.getUser('t')).rejects.toThrow('not verified');
      claims.email_verified = 'true';
      await expect(provider.getUser('t')).resolves.toEqual({ id: 'a-1', email: 'a@b.example' });
      claims.email_verified = true;
      await expect(provider.getUser('t')).resolves.toEqual({ id: 'a-1', email: 'a@b.example' });
    } finally {
      global.fetch = realFetch;
      for (const k of ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY']) delete process.env[k];
    }
  });
});

// ---- POSTIZ_GENERIC_OAUTH is never read by the sign in code changed here --------------------------------------------------

describe('POSTIZ_GENERIC_OAUTH', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/\.spec\.ts$/.test(f) ? [p] : [];
    });
  const root = join(__dirname, '..', '..');
  const owned = [
    ...walk(join(root, 'services', 'auth')),
    join(root, 'api', 'routes', 'auth.controller.ts'),
    ...walk(join(root, 'public-api', 'provisioning')),
    ...walk(join(root, '..', '..', 'frontend', 'src', 'components', 'auth')),
    ...walk(join(root, '..', '..', 'frontend', 'src', 'app', '(app)', 'auth')),
  ];

  it('is not mentioned, read or branched on in any sign in source changed here', () => {
    expect(owned.length).toBeGreaterThan(20);
    const hits = owned.filter((f) => /POSTIZ_GENERIC_OAUTH|genericOauth|GENERIC_OAUTH/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
