// Tests for the owner route: PUT /public/v1/provisioning/workspaces/:externalRef/owner   body {"email"}
// Prisma is mocked by in-memory models; the mail transport is a stub nodemailer behind the real EmailService
// (EMAIL_PROVIDER=nodemailer). Nothing here opens a database, runs prisma generate or db push, or sends a mail.
// Run from the repository root:  pnpm exec jest -c apps/backend/jest.config.cjs apps/backend/src/public-api/provisioning

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail: (...a: any[]) => mockSendMail(...a) }) },
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service', () => ({ OAuthService: class {} }));
jest.mock('@gitroom/nestjs-libraries/sentry/initialize.sentry', () => ({ setSentryUserContext: () => undefined }));
jest.mock('@gitroom/nestjs-libraries/services/exception.filter', () => ({
  HttpForbiddenException: class extends Error {},
}));

import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ProvisioningRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.repository';
import { ProvisioningService } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.service';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { ProvisioningController } from '@gitroom/backend/public-api/provisioning/provisioning.controller';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { passwordFingerprint } from '@gitroom/backend/services/auth/reset.token';
import { readFileSync } from 'fs';
import { join } from 'path';

const TOKEN = 'T0ken._~+/=-abcdefghijklmnopqrstuvwxyz0123456789';
const REF = 'a'.repeat(32);
const REF_2 = 'b1'.repeat(16);
const EMAIL = 'owner@paid.example';
const WS = '/public/v1/provisioning/workspaces/';

// ---- the mocked Prisma ------------------------------------------------------------------------------------------------

const p2002 = (f: string) => Object.assign(new Error(`Unique constraint failed on the fields: (\`${f}\`)`), { code: 'P2002' });

class OrganizationModel {
  rows: any[] = [];
  createCalls: any[] = [];
  async findUnique({ where, select }: any) {
    const row = this.rows.find((r) => r.externalRef === where.externalRef);
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
  }
  async create({ data, select }: any) {
    this.createCalls.push(data);
    const row = { id: 'org-' + (this.rows.length + 1), deletedAt: null, ...data };
    this.rows.push(row);
    return Object.fromEntries(Object.keys(select).map((k) => [k, (row as any)[k]]));
  }
  async update() {
    throw new Error('the owner route must never update an organization');
  }
  async delete() {
    throw new Error('the owner route must never delete an organization');
  }
}

class Db {
  organization = new OrganizationModel();
  userRows: any[] = [];
  memberRows: any[] = [];
  userCreateCalls: any[] = [];
  user = {
    findFirst: async ({ where }: any) => {
      const row = this.userRows.find(
        (u) =>
          u.email.toLowerCase() === String(where.email.equals).toLowerCase() &&
          u.providerName === where.providerName &&
          u.deletedAt === where.deletedAt
      );
      return row ? { id: row.id, email: row.email } : null;
    },
    create: async ({ data }: any) => {
      this.userCreateCalls.push(data);
      if (this.userRows.some((u) => u.email === data.email && u.providerName === data.providerName)) {
        throw p2002('email, providerName');
      }
      const { organizations, ...fields } = data;
      const row = { id: 'user-' + (this.userRows.length + 1), deletedAt: null, ...fields };
      this.userRows.push(row);
      if (organizations?.create) {
        this.memberRows.push({ id: 'm-' + (this.memberRows.length + 1), userId: row.id, ...organizations.create });
      }
      return { id: row.id, email: row.email };
    },
    update: async () => {
      throw new Error('the owner route must never update a user');
    },
    delete: async () => {
      throw new Error('the owner route must never delete a user');
    },
  };
  userOrganization = {
    findFirst: async ({ where }: any) => {
      const m = this.memberRows.find(
        (x) => x.organizationId === where.organizationId && (where.role === undefined || x.role === where.role)
      );
      if (!m) return null;
      return { id: m.id, role: m.role, user: { id: m.userId, email: this.userRows.find((u) => u.id === m.userId).email } };
    },
    create: async ({ data }: any) => {
      if (this.memberRows.some((x) => x.userId === data.userId && x.organizationId === data.organizationId)) {
        throw p2002('userId, organizationId');
      }
      const row = { id: 'm-' + (this.memberRows.length + 1), ...data };
      this.memberRows.push(row);
      return row;
    },
  };
}

// ---- the app under test -----------------------------------------------------------------------------------------------

const ENV_KEYS = [
  'PROVISIONING_TOKEN',
  'JWT_SECRET',
  'FRONTEND_URL',
  'EMAIL_PROVIDER',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME',
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_SECURE',
  'EMAIL_USER',
  'EMAIL_PASS',
];
let saved: Record<string, string | undefined>;
let db: Db;
let app: INestApplication;
let base: string;
let logged: string[];

async function buildApp() {
  const prisma = { model: db };
  @Module({
    controllers: [ProvisioningController],
    providers: [
      ProvisioningService,
      ProvisioningRepository,
      { provide: PrismaRepository, useValue: prisma },
      { provide: EmailService, useValue: new EmailService({} as any) },
    ],
  })
  class TestModule {}
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

beforeEach(async () => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PROVISIONING_TOKEN = TOKEN;
  process.env.JWT_SECRET = 'a-test-jwt-secret-that-is-long-enough';
  process.env.FRONTEND_URL = 'https://social.example';
  process.env.EMAIL_PROVIDER = 'nodemailer';
  process.env.EMAIL_FROM_ADDRESS = 'hello@social.example';
  process.env.EMAIL_FROM_NAME = 'Sedulia Social';
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ accepted: [EMAIL], messageId: '<id@stub>' });
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, m).mockImplementation((...args: any[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, Object.getOwnPropertyNames(Object(a))))).join(' '));
    });
  }
  db = new Db();
  await buildApp();
});

afterEach(async () => {
  await app.close();
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type Resp = { status: number; json: any; text: string; headers: Headers };
async function put(path: string, body: any, auth: string | null = 'Bearer ' + TOKEN): Promise<Resp> {
  const headers: any = { 'Content-Type': 'application/json' };
  if (auth !== null) headers.Authorization = auth;
  const res = await fetch(base + path, { method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const workspace = (ref = REF, name = 'acme') => put(WS + ref, { name });
const owner = (ref = REF, email: any = EMAIL, extra: any = {}, auth: string | null = 'Bearer ' + TOKEN) =>
  put(WS + ref + '/owner', { email, ...extra }, auth);

const sent = () => mockSendMail.mock.calls.map((c) => c[0]);
const resetToken = (html: string) => /\/auth\/forgot\/([A-Za-z0-9._-]+)/.exec(html)![1];

// ---- the token -----------------------------------------------------------------------------------------------------------

describe('the provisioning token', () => {
  it('is required: no header, a wrong token and a wrong scheme are 401 and change nothing', async () => {
    await workspace();
    for (const auth of [null, 'Bearer wrong', 'Basic ' + TOKEN, 'Bearer', TOKEN]) {
      const r = await owner(REF, EMAIL, {}, auth);
      expect(r.status).toBe(401);
    }
    expect(db.userRows).toHaveLength(0);
    expect(db.memberRows).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['']])('the route does not exist (404) while PROVISIONING_TOKEN is %j', async (value) => {
    await workspace();
    if (value === undefined) delete process.env.PROVISIONING_TOKEN;
    else process.env.PROVISIONING_TOKEN = value;
    const r = await owner(REF, EMAIL, {}, 'Bearer ' + TOKEN);
    expect(r.status).toBe(404);
    expect(db.userRows).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('is the same guard the workspace route uses, declared on the controller', () => {
    const src = readFileSync(join(__dirname, 'provisioning.controller.ts'), 'utf8');
    expect(src).toMatch(/@UseGuards\(ProvisioningTokenGuard\)\s*export class ProvisioningController/);
    expect(src).toMatch(/@Put\('\/:externalRef\/owner'\)/);
  });
});

// ---- the owner --------------------------------------------------------------------------------------------------------------

describe('the first call for a workspace and an address', () => {
  it('makes one user with no password, never a super admin, owner of that one workspace, and answers 201', async () => {
    await workspace();
    const r = await owner();

    expect(r.status).toBe(201);
    expect(r.json).toEqual({ externalRef: REF, email: EMAIL, created: true, emailed: true });
    expect(db.userRows).toHaveLength(1);
    expect(db.userRows[0]).toMatchObject({
      email: EMAIL,
      providerName: 'LOCAL',
      password: '',
      isSuperAdmin: false,
      activated: true,
      deletedAt: null,
    });
    expect(db.memberRows).toEqual([expect.objectContaining({ userId: db.userRows[0].id, organizationId: 'org-1', role: 'SUPERADMIN' })]);
    expect(db.organization.createCalls).toHaveLength(1); // only the workspace call made an organization
  });

  it('ignores any field the caller adds: no super admin, no role, no password, no other organization', async () => {
    await workspace();
    const r = await owner(REF, EMAIL, {
      isSuperAdmin: true,
      role: 'SUPERADMIN',
      password: 'hunter2hunter2',
      organizationId: 'org-9',
      providerName: 'GOOGLE',
      activated: false,
    });
    expect(r.status).toBe(201);
    expect(db.userRows[0]).toMatchObject({ isSuperAdmin: false, password: '', providerName: 'LOCAL', activated: true });
    expect(db.memberRows[0].organizationId).toBe('org-1');
  });

  it('sends exactly one set-password email through nodemailer, the link only inside it', async () => {
    await workspace();
    const r = await owner();
    expect(r.status).toBe(201);

    expect(sent()).toHaveLength(1);
    const mail = sent()[0];
    expect(mail.to).toBe(EMAIL);
    expect(mail.from).toBe('Sedulia Social <hello@social.example>');
    expect(mail.subject).toMatch(/password/i);
    const link = /https:\/\/social\.example\/auth\/forgot\/[A-Za-z0-9._-]+/.exec(mail.html);
    expect(link).not.toBeNull();

    // the link is a signed reset for this user, good for days, not minutes
    const claims: any = AuthChecker.verifyJWT(resetToken(mail.html));
    expect(claims.id).toBe(db.userRows[0].id);
    // a reset token, not a session: kind reset, and tied to the empty password the owner has now (so it works once)
    expect(claims.kind).toBe('reset');
    expect(claims.pw).toBe(passwordFingerprint(''));
    const hours = (new Date(claims.expires.replace(' ', 'T') + 'Z').getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(24);
    expect(hours).toBeLessThan(24 * 8);
  });

  it('puts no link, token or password in the response, its headers or any log line', async () => {
    await workspace();
    const r = await owner();
    const token = resetToken(sent()[0].html);

    const everything = [r.text, JSON.stringify([...r.headers.entries()]), ...logged].join('\n');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain('/auth/forgot');
    expect(everything).not.toMatch(/https?:\/\/social\.example/);
    expect(everything).not.toContain(TOKEN);
    expect(Object.keys(r.json).sort()).toEqual(['created', 'email', 'emailed', 'externalRef']);
    expect(r.headers.get('location')).toBeNull();
  });

  it('the link works: it is the reset the sign in page accepts, so the owner can set a first password', async () => {
    await workspace();
    await owner();
    const claims: any = AuthChecker.verifyJWT(resetToken(sent()[0].html));
    expect(typeof claims.id).toBe('string');
    expect(typeof claims.expires).toBe('string'); // the shape forgotReturn reads
  });
});

describe('idempotent on the workspace reference and the address', () => {
  it('a repeat is 200, makes nothing and sends nothing', async () => {
    await workspace();
    const first = await owner();
    const again = await owner();
    const spaced = await owner(REF, '  Owner@Paid.example ');

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(spaced.status).toBe(200);
    expect(again.json).toEqual({ externalRef: REF, email: EMAIL, created: false, emailed: false });
    expect(db.userRows).toHaveLength(1);
    expect(db.memberRows).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it('two calls at once make one user, one membership and one email', async () => {
    await workspace();
    const [a, b] = await Promise.all([owner(), owner()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(db.userRows).toHaveLength(1);
    expect(db.memberRows).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it('a different address for a workspace that already has an owner is 409 and changes nothing', async () => {
    await workspace();
    await owner();
    const r = await owner(REF, 'someone.else@paid.example');
    expect(r.status).toBe(409);
    expect(r.text).not.toContain(EMAIL);
    expect(db.userRows).toHaveLength(1);
    expect(db.memberRows).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it('an address that already has a user (another workspace) joins this one as owner, with no second user and no email', async () => {
    await workspace(REF, 'acme');
    await workspace(REF_2, 'second');
    await owner(REF);
    const r = await owner(REF_2);

    expect(r.status).toBe(201);
    expect(r.json).toEqual({ externalRef: REF_2, email: EMAIL, created: true, emailed: false });
    expect(db.userRows).toHaveLength(1);
    expect(db.memberRows.map((m) => m.organizationId).sort()).toEqual(['org-1', 'org-2']);
    expect(sent()).toHaveLength(1);
  });
});

describe('refusals', () => {
  it('is 404 for a workspace reference nobody made, and makes no organization', async () => {
    const r = await owner(REF);
    expect(r.status).toBe(404);
    expect(db.organization.createCalls).toHaveLength(0);
    expect(db.userRows).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('is 409 for a closed workspace', async () => {
    await workspace();
    db.organization.rows[0].deletedAt = new Date();
    const r = await owner();
    expect(r.status).toBe(409);
    expect(db.userRows).toHaveLength(0);
  });

  it.each([['not-hex'], ['A'.repeat(32)], ['a'.repeat(31)], ['a'.repeat(33)]])('is 400 for the reference %j', async (ref) => {
    const r = await owner(ref);
    expect(r.status).toBe(400);
    expect(db.userRows).toHaveLength(0);
  });

  it.each([[null], [''], ['nope'], ['a@b'], [42], [['x@y.example']], [{}], ['x'.repeat(250) + '@y.example']])(
    'is 400 for the email %j',
    async (email) => {
      await workspace();
      const r = await owner(REF, email);
      expect(r.status).toBe(400);
      expect(db.userRows).toHaveLength(0);
      expect(mockSendMail).not.toHaveBeenCalled();
    }
  );

  it('is 400 when the body has no email at all', async () => {
    await workspace();
    expect((await put(WS + REF + '/owner', {})).status).toBe(400);
    expect(db.userRows).toHaveLength(0);
  });

  it('is 400 for a body that is not an object', async () => {
    await workspace();
    for (const body of ['null', '[]', '"a@b.example"']) {
      expect((await put(WS + REF + '/owner', body)).status).toBe(400);
    }
    expect(db.userRows).toHaveLength(0);
  });

  it.each([['EMAIL_PROVIDER', undefined], ['EMAIL_FROM_ADDRESS', undefined], ['EMAIL_FROM_NAME', undefined]])(
    'is 503 and writes nothing while %s is unset, so no owner is made that nobody can sign in as',
    async (key) => {
      await workspace();
      await app.close();
      delete process.env[key];
      await buildApp();
      const r = await owner();
      expect(r.status).toBe(503);
      expect(db.userRows).toHaveLength(0);
      expect(db.memberRows).toHaveLength(0);
      expect(mockSendMail).not.toHaveBeenCalled();
    }
  );
});

describe('the workspace route is unchanged', () => {
  it('still makes a workspace and still returns the key, and makes no user', async () => {
    const r = await workspace();
    expect(r.status).toBe(201);
    expect(typeof r.json.apiKey).toBe('string');
    expect(db.userRows).toHaveLength(0);
  });
});
