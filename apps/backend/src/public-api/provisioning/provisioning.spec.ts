// Tests for the provisioning route: PUT /public/v1/provisioning/workspaces/:externalRef
// Prisma is mocked by an in-memory organization model; nothing here opens a database, runs prisma generate or db push.
// Run from the repository root:  node_modules/.bin/jest -c apps/backend/jest.config.cjs

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) }; // the real compare, counted
});
jest.mock('@gitroom/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service', () => ({
  OAuthService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/sentry/initialize.sentry', () => ({
  setSentryUserContext: () => undefined,
}));
jest.mock('@gitroom/nestjs-libraries/services/exception.filter', () => ({
  HttpForbiddenException: class extends Error {},
}));

import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Controller, Get, INestApplication, MiddlewareConsumer, Module, NestModule, Req, RequestMethod, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { ProvisioningRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.repository';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { ProvisioningService } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.service';
import { PublicAuthMiddleware } from '@gitroom/backend/services/auth/public.auth.middleware';
import { ProvisioningController } from '@gitroom/backend/public-api/provisioning/provisioning.controller';
import { ProvisioningTokenGuard } from '@gitroom/backend/public-api/provisioning/provisioning.token.guard';

const TOKEN = 'T0ken._~+/=-abcdefghijklmnopqrstuvwxyz0123456789';
const REF_A = 'a'.repeat(32);
const REF_B = 'b1'.repeat(16);
const BASE = '/public/v1/provisioning/workspaces/';
const KEY_RX = /^[A-Za-z0-9._~+/=-]{16,512}$/;

// ---- the mocked Prisma: an in-memory organization model ----------------------------------------------------------

class FakeOrganizationModel {
  rows: any[] = [];
  createCalls: any[] = [];
  updateCalls: any[] = [];
  deleteCalls: any[] = [];
  readsBarrier: Promise<void> | null = null; // makes concurrent callers read before either writes
  failNextCreateWith: any = null;
  failNextReadWith: any = null;

  private pick(row: any, select?: any) {
    if (!row) return null;
    if (!select) return { ...row };
    const out: any = {};
    for (const k of Object.keys(select)) out[k] = row[k];
    return out;
  }

  async findUnique({ where, select }: any) {
    if (this.failNextReadWith) {
      const e = this.failNextReadWith;
      this.failNextReadWith = null;
      throw e;
    }
    if (this.readsBarrier) await this.readsBarrier;
    return this.pick(this.rows.find((r) => r.externalRef === where.externalRef), select);
  }

  async findFirst({ where }: any) {
    const row = this.rows.find(
      (r) =>
        (where.apiKey === undefined || r.apiKey === where.apiKey) &&
        (where.deletedAt === undefined || r.deletedAt === where.deletedAt)
    );
    return row ? { ...row, subscription: row.subscription ?? null } : null;
  }

  async create({ data, select }: any) {
    this.createCalls.push(data);
    if (this.failNextCreateWith) {
      const e = this.failNextCreateWith;
      this.failNextCreateWith = null;
      throw e;
    }
    if (data.externalRef != null && this.rows.some((r) => r.externalRef === data.externalRef)) {
      throw Object.assign(new Error('Unique constraint failed on the fields: (`externalRef`)'), { code: 'P2002' });
    }
    const row = { id: crypto.randomUUID(), deletedAt: null, description: null, paymentId: null, ...data };
    this.rows.push(row);
    return this.pick(row, select);
  }

  async update(args: any) {
    this.updateCalls.push(args);
    throw new Error('the provisioning route must never update an organization');
  }

  async delete(args: any) {
    this.deleteCalls.push(args);
    throw new Error('the provisioning route must never delete an organization');
  }
}

// ---- the app under test -------------------------------------------------------------------------------------------

@Controller('/public/v1')
class MeStub {
  // The real GET /public/v1/me answers { organization: { id: org.id, name: org.name } } from req.org
  // (apps/backend/src/public-api/routes/v1/public.integrations.controller.ts, getMe).
  @Get('/me')
  me(@Req() req: any) {
    return { organization: { id: req.org.id, name: req.org.name }, user: null };
  }
}

async function buildApp(model: FakeOrganizationModel): Promise<{ app: INestApplication; base: string }> {
  const prisma = { model: { organization: model } };
  const orgRepo = new OrganizationRepository(prisma as any, {} as any, {} as any);
  const middleware = new PublicAuthMiddleware(
    { getOrgByApiKey: (k: string) => orgRepo.getOrgByApiKey(k), canUseSuperAdminApi: async () => false } as any,
    {} as any
  );

  @Module({
    controllers: [ProvisioningController, MeStub],
    providers: [
      ProvisioningService,
      ProvisioningRepository,
      { provide: PrismaRepository, useValue: prisma },
      { provide: EmailService, useValue: {} }, // the controller's owner route needs it; these tests never call that route
    ],
  })
  class TestModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      // as PublicApiModule does: the per-organization middleware covers the authenticated controller only
      consumer.apply((req: any, res: any, next: any) => middleware.use(req, res, next)).forRoutes(MeStub);
    }
  }

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true })); // as main.ts
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base };
}

type Resp = { status: number; json: any; text: string };
async function call(base: string, method: string, path: string, opts: { auth?: string | null; body?: any; headers?: any } = {}): Promise<Resp> {
  const headers: any = { ...(opts.headers || {}) };
  if (opts.auth !== null && opts.auth !== undefined) headers.Authorization = opts.auth;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}
const put = (base: string, ref: string, body: any, auth: string | null = 'Bearer ' + TOKEN) =>
  call(base, 'PUT', BASE + ref, { auth, body });

// ---- shared setup -------------------------------------------------------------------------------------------------

const ENV_KEYS = ['PROVISIONING_TOKEN', 'JWT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'MCP_ONLY'];
let saved: Record<string, string | undefined>;
let model: FakeOrganizationModel;
let app: INestApplication;
let base: string;

beforeEach(async () => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PROVISIONING_TOKEN = TOKEN;
  process.env.JWT_SECRET = 'a-test-jwt-secret-that-is-long-enough';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  model = new FakeOrganizationModel();
  ({ app, base } = await buildApp(model));
});

afterEach(async () => {
  await app.close();
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ---- auth: the route answers only to the provisioning token ---------------------------------------------------------

describe('auth', () => {
  it.each([[undefined], [''], ['   ']])('is a 404 while PROVISIONING_TOKEN is %j, whatever the caller sends', async (value) => {
    if (value === undefined) delete process.env.PROVISIONING_TOKEN;
    else process.env.PROVISIONING_TOKEN = value;
    for (const auth of ['Bearer ' + TOKEN, 'Bearer ', 'Bearer x', null]) {
      const r = await put(base, REF_A, { name: 'acme' }, auth);
      expect(r.status).toBe(404);
    }
    expect(model.createCalls).toHaveLength(0);
  });

  it('is a 404 for an empty token even when the caller also sends an empty bearer', async () => {
    process.env.PROVISIONING_TOKEN = '';
    const r = await call(base, 'PUT', BASE + REF_A, { auth: 'Bearer ', body: { name: 'acme' } });
    expect(r.status).toBe(404);
    expect(model.rows).toHaveLength(0);
  });

  it('reads the token at each request, so setting it later turns the route on', async () => {
    delete process.env.PROVISIONING_TOKEN;
    expect((await put(base, REF_A, { name: 'acme' })).status).toBe(404);
    process.env.PROVISIONING_TOKEN = TOKEN;
    expect((await put(base, REF_A, { name: 'acme' })).status).toBe(201);
  });

  it.each([
    ['a missing header', null],
    ['an empty header', ''],
    ['a wrong token', 'Bearer ' + TOKEN + 'x'],
    ['a prefix of the token', 'Bearer ' + TOKEN.slice(0, -1)],
    ['a different token of the same length', 'Bearer ' + 'z'.repeat(TOKEN.length)],
    ['a bare token with no scheme', TOKEN],
    ['the Basic scheme', 'Basic ' + TOKEN],
    ['a lower case scheme', 'bearer ' + TOKEN],
    ['an empty bearer', 'Bearer '],
    ['two spaces', 'Bearer  ' + TOKEN],
    ['an organization API key shaped value', 'Bearer ' + '0'.repeat(64)],
  ])('answers 401 for %s and creates nothing', async (_label, auth) => {
    const r = await put(base, REF_A, { name: 'acme' }, auth as any);
    expect(r.status).toBe(401);
    expect(r.text).not.toContain(TOKEN);
    expect(model.createCalls).toHaveLength(0);
  });

  it('compares in constant time (crypto.timingSafeEqual on equal length digests, so a short or long token is a 401, not a crash)', async () => {
    const spy = crypto.timingSafeEqual as unknown as jest.Mock;
    spy.mockClear();
    const wrong = await put(base, REF_A, { name: 'acme' }, 'Bearer short');
    const right = await put(base, REF_A, { name: 'acme' });
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
  });

  it('does not use the organization API key door: an org key is not the provisioning token', async () => {
    const created = await put(base, REF_A, { name: 'acme' });
    const r = await put(base, REF_B, { name: 'beta_co' }, 'Bearer ' + created.json.apiKey);
    expect(r.status).toBe(401);
  });

  it('answers a 404 to a wrong token on a path that is not the route, and the guard runs before validation', async () => {
    const bad = await put(base, 'NOT-A-REF', { name: '!!' }, 'Bearer wrong');
    expect(bad.status).toBe(401); // not a 400: validation never runs for a caller without the token
  });
});

// ---- input shape ------------------------------------------------------------------------------------------------------

describe('input', () => {
  it.each([
    ['upper case hex', 'A'.repeat(32)],
    ['31 characters', 'a'.repeat(31)],
    ['33 characters', 'a'.repeat(33)],
    ['not hex', 'g'.repeat(32)],
    ['a checkout id shape', 'cs_live_' + 'a'.repeat(24)],
    ['a dotted path', '..%2f' + 'a'.repeat(27)],
    ['hex with a dash', 'a'.repeat(31) + '-'],
  ])('refuses a ref that is %s with a 4xx and creates nothing', async (_l, ref) => {
    const r = await put(base, ref, { name: 'acme' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(model.createCalls).toHaveLength(0);
  });

  it.each([
    ['missing', {}],
    ['null', { name: null }],
    ['empty', { name: '' }],
    ['one character', { name: 'a' }],
    ['41 characters after the first', { name: 'a'.repeat(42) }],
    ['upper case', { name: 'Upper' }],
    ['a dash', { name: 'has-a-dash' }],
    ['a leading underscore', { name: '_acme' }],
    ['a space', { name: 'two words' }],
    ['a hash suffix like createMaxUser makes', { name: 'acme###abc' }],
    ['a number', { name: 123 }],
    ['an array', { name: ['acme'] }],
    ['an object', { name: { $ne: 'x' } }],
    ['a newline at the end', { name: 'acme\n' }],
  ])('refuses a name that is %s with a 4xx and creates nothing', async (_l, body) => {
    const r = await put(base, REF_A, body);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(model.createCalls).toHaveLength(0);
  });

  it('refuses a body that is not JSON, an array, or absent', async () => {
    for (const body of ['not json', '[]', '"acme"']) {
      const r = await put(base, REF_A, body);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    const none = await call(base, 'PUT', BASE + REF_A, { auth: 'Bearer ' + TOKEN });
    expect(none.status).toBeGreaterThanOrEqual(400);
    expect(none.status).toBeLessThan(500);
    expect(model.createCalls).toHaveLength(0);
  });

  it.each(['ab', 'acme', 'two_words_here', '9lives', 'a'.repeat(41)])('accepts the slug %s', async (name) => {
    const r = await put(base, REF_A, { name });
    expect(r.status).toBe(201);
    expect(r.json.name).toBe(name);
  });
});

// ---- idempotency ----------------------------------------------------------------------------------------------------

describe('idempotency', () => {
  it('the first call answers 201 with exactly {id, name, externalRef, apiKey, created: true}', async () => {
    const r = await put(base, REF_A, { name: 'acme' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(['apiKey', 'created', 'externalRef', 'id', 'name']);
    expect(r.json.created).toBe(true);
    expect(r.json.name).toBe('acme');
    expect(r.json.externalRef).toBe(REF_A);
    expect(typeof r.json.id).toBe('string');
    expect(r.json.id.length).toBeGreaterThan(0);
    expect(r.json.apiKey).toMatch(KEY_RX);
  });

  it('a repeat answers 200 with the same id, name and apiKey and created false', async () => {
    const first = await put(base, REF_A, { name: 'acme' });
    const again = await put(base, REF_A, { name: 'acme' });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ...first.json, created: false });
    expect(model.rows).toHaveLength(1);
    expect(model.createCalls).toHaveLength(1);
  });

  it('a repeat never renames: a different name gets the stored name back and nothing is updated', async () => {
    const first = await put(base, REF_A, { name: 'acme' });
    const again = await put(base, REF_A, { name: 'someone_else' });
    expect(again.status).toBe(200);
    expect(again.json.name).toBe('acme');
    expect(again.json.id).toBe(first.json.id);
    expect(again.json.apiKey).toBe(first.json.apiKey);
    expect(model.rows[0].name).toBe('acme');
    expect(model.updateCalls).toHaveLength(0);
  });

  it('a repeat never rotates the key, however many times it is called', async () => {
    const first = await put(base, REF_A, { name: 'acme' });
    for (let i = 0; i < 5; i++) {
      const r = await put(base, REF_A, { name: 'acme' });
      expect(r.json.apiKey).toBe(first.json.apiKey);
    }
    expect(model.createCalls).toHaveLength(1);
  });

  it('a unique violation in a race re-reads and returns the winner (scripted)', async () => {
    // the loser read nothing, then its create hits the unique index because the winner just wrote
    const winner = await put(base, REF_A, { name: 'acme' });
    const realFind = model.findUnique.bind(model);
    let reads = 0;
    model.findUnique = async (args: any) => (reads++ === 0 ? null : realFind(args));
    const loser = await put(base, REF_A, { name: 'acme' });
    expect(loser.status).toBe(200);
    expect(loser.json).toEqual({ ...winner.json, created: false });
    expect(model.rows).toHaveLength(1);
  });

  it('two truly concurrent first calls make one organization; one answers 201, the other 200, with one id and one key', async () => {
    let release!: () => void;
    model.readsBarrier = new Promise<void>((r) => (release = r));
    const both = Promise.all([put(base, REF_A, { name: 'acme' }), put(base, REF_A, { name: 'acme' })]);
    await new Promise((r) => setTimeout(r, 150)); // both are now past the read
    model.readsBarrier = null;
    release();
    const [x, y] = await both;
    expect(model.rows).toHaveLength(1);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.json.id).toBe(y.json.id);
    expect(x.json.apiKey).toBe(y.json.apiKey);
    expect([x.json.created, y.json.created].sort()).toEqual([false, true]);
  });

  it('a unique violation with no winner to read is a 500 that carries no key', async () => {
    model.failNextCreateWith = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const r = await put(base, REF_A, { name: 'acme' });
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/apiKey/);
    expect(model.rows).toHaveLength(0);
  });

  it('any other database error is a 500, creates nothing and leaks no key or token', async () => {
    model.failNextCreateWith = new Error('connection refused to 10.0.0.5 with ' + TOKEN);
    const r = await put(base, REF_A, { name: 'acme' });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toContain('10.0.0.5');
    expect(model.rows).toHaveLength(0);
  });

  it('a read error is a 500 and creates nothing', async () => {
    model.failNextReadWith = new Error('boom');
    const r = await put(base, REF_A, { name: 'acme' });
    expect(r.status).toBe(500);
    expect(model.createCalls).toHaveLength(0);
  });

  it('two refs never share an id or a key (many, in parallel)', async () => {
    const refs = Array.from({ length: 25 }, (_v, i) => crypto.createHash('sha256').update('ref' + i).digest('hex').slice(0, 32));
    const out = await Promise.all(refs.map((ref, i) => put(base, ref, { name: 'tenant_' + i })));
    expect(out.every((r) => r.status === 201)).toBe(true);
    expect(new Set(out.map((r) => r.json.id)).size).toBe(refs.length);
    expect(new Set(out.map((r) => r.json.apiKey)).size).toBe(refs.length);
    expect(new Set(model.rows.map((r) => r.externalRef)).size).toBe(refs.length);
  });

  it('two refs with the same name are two organizations with two keys (the name is not the identity)', async () => {
    const a = await put(base, REF_A, { name: 'acme' });
    const b = await put(base, REF_B, { name: 'acme' });
    expect(a.json.id).not.toBe(b.json.id);
    expect(a.json.apiKey).not.toBe(b.json.apiKey);
  });

  it('a ref whose organization was deleted is a 409 with no key, never a live looking grant', async () => {
    await put(base, REF_A, { name: 'acme' });
    model.rows[0].deletedAt = new Date();
    const r = await put(base, REF_A, { name: 'acme' });
    expect(r.status).toBe(409);
    expect(r.text).not.toMatch(/apiKey/);
    expect(model.rows).toHaveLength(1);
  });
});

// ---- the key works against Postiz's own public API door ----------------------------------------------------------------

describe('the issued key', () => {
  it('matches the shape a caller checks before it will send it', async () => {
    const r = await put(base, REF_A, { name: 'acme' });
    expect(r.json.apiKey).toMatch(KEY_RX);
    expect(r.json.apiKey.length).toBeGreaterThanOrEqual(16);
  });

  it('GET /public/v1/me with it returns that organization\'s id and the bare name, through the real PublicAuthMiddleware', async () => {
    const a = await put(base, REF_A, { name: 'acme' });
    const b = await put(base, REF_B, { name: 'beta_co' });
    const meA = await call(base, 'GET', '/public/v1/me', { auth: a.json.apiKey });
    const meB = await call(base, 'GET', '/public/v1/me', { auth: b.json.apiKey });
    expect(meA.status).toBe(200);
    expect(meA.json.organization).toEqual({ id: a.json.id, name: 'acme' });
    expect(meB.json.organization).toEqual({ id: b.json.id, name: 'beta_co' });
  });

  it('passes PublicAuthMiddleware with STRIPE_SECRET_KEY unset, though the organization has no subscription row', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const a = await put(base, REF_A, { name: 'acme' });
    expect(model.rows[0].subscription).toBeUndefined();
    expect((await call(base, 'GET', '/public/v1/me', { auth: a.json.apiKey })).status).toBe(200);
  });

  it('an unknown key and the provisioning token are both refused by the door (401)', async () => {
    await put(base, REF_A, { name: 'acme' });
    expect((await call(base, 'GET', '/public/v1/me', { auth: 'x'.repeat(40) })).status).toBe(401);
    expect((await call(base, 'GET', '/public/v1/me', { auth: TOKEN })).status).toBe(401);
  });

  it('the x-postiz-org header cannot make the new key act as another organization', async () => {
    const a = await put(base, REF_A, { name: 'acme' });
    const b = await put(base, REF_B, { name: 'beta_co' });
    const r = await call(base, 'GET', '/public/v1/me', { auth: a.json.apiKey, headers: { 'x-postiz-org': b.json.id } });
    expect(r.status).toBe(403);
  });
});

// ---- boundary: nothing here reaches super admin, another org or a delete ------------------------------------------------

describe('boundary', () => {
  it('writes only name, externalRef and apiKey: no user, no membership, no subscription, no super admin flag', async () => {
    await put(base, REF_A, { name: 'acme' });
    expect(model.createCalls).toHaveLength(1);
    expect(Object.keys(model.createCalls[0]).sort()).toEqual(['apiKey', 'externalRef', 'name']);
  });

  it('ignores every extra input: body fields and headers never reach what is written or who it acts as', async () => {
    const r = await call(base, 'PUT', BASE + REF_A, {
      auth: 'Bearer ' + TOKEN,
      headers: { 'x-postiz-org': 'some-other-org', 'x-postiz-include-deleted': 'true' },
      body: {
        name: 'acme',
        isSuperAdmin: true,
        role: 'SUPERADMIN',
        users: { create: { role: 'SUPERADMIN' } },
        subscription: { create: { totalChannels: 1000000, subscriptionTier: 'ULTIMATE' } },
        apiKey: 'chosen-by-the-caller-0123456789',
        id: 'chosen-id',
        externalRef: 'f'.repeat(32),
        paymentId: 'cus_x',
        deletedAt: null,
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.externalRef).toBe(REF_A);
    expect(r.json.apiKey).not.toBe('chosen-by-the-caller-0123456789');
    expect(r.json.id).not.toBe('chosen-id');
    expect(Object.keys(model.createCalls[0]).sort()).toEqual(['apiKey', 'externalRef', 'name']);
  });

  it('answers 404 to every other method on the path and on the collection: no read, list, post or delete', async () => {
    const made = await put(base, REF_A, { name: 'acme' });
    for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
      for (const path of [BASE + REF_A, BASE.slice(0, -1), BASE + REF_A + '/owner', BASE + REF_A + '/apiKey']) {
        const r = await call(base, method, path, { auth: 'Bearer ' + TOKEN, body: method === 'GET' ? undefined : { name: 'acme' } });
        expect(r.status).toBe(404);
        expect(r.text).not.toContain(made.json.apiKey);
      }
    }
    expect(model.deleteCalls).toHaveLength(0);
    expect(model.updateCalls).toHaveLength(0);
    expect(model.rows).toHaveLength(1);
  });

  it('has exactly two routes, both PUT: /:externalRef and /:externalRef/owner', () => {
    const proto = ProvisioningController.prototype as any;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');
    expect(handlers.sort()).toEqual(['ensureOwner', 'ensureWorkspace']);
    expect(Reflect.getMetadata('path', ProvisioningController)).toBe('/public/v1/provisioning/workspaces');
    for (const [name, path] of [['ensureWorkspace', '/:externalRef'], ['ensureOwner', '/:externalRef/owner']]) {
      expect(Reflect.getMetadata('method', proto[name])).toBe(RequestMethod.PUT);
      expect(Reflect.getMetadata('path', proto[name])).toBe(path);
    }
  });

  it('is guarded by the provisioning token guard', () => {
    const guards = Reflect.getMetadata('__guards__', ProvisioningController) || [];
    expect(guards).toContain(ProvisioningTokenGuard);
  });
});

// ---- registration: the controller is outside authenticatedController -----------------------------------------------------

describe('module registration (public.api.module.ts)', () => {
  const source = readFileSync(join(__dirname, '..', 'public.api.module.ts'), 'utf8');

  it('lists ProvisioningController in the module controllers', () => {
    const controllers = /controllers:\s*([\s\S]*?),\n  providers:/.exec(source);
    expect(controllers).not.toBeNull();
    expect(controllers![1]).toContain('ProvisioningController');
  });

  it('keeps ProvisioningController out of authenticatedController, so the per-organization middleware never covers it', () => {
    const list = /const authenticatedController\s*=\s*\[([^\]]*)\]/.exec(source);
    expect(list).not.toBeNull();
    expect(list![1]).toContain('PublicIntegrationsController');
    expect(list![1]).not.toContain('Provisioning');
    const applied = /consumer\.apply\(PublicAuthMiddleware\)\.forRoutes\(([^)]*)\)/.exec(source);
    expect(applied).not.toBeNull();
    expect(applied![1]).toBe('...authenticatedController');
  });

  it('provides the repository and the service', () => {
    expect(source).toContain('ProvisioningRepository');
    expect(source).toContain('ProvisioningService');
  });

  it('the real getMe still answers {organization: {id, name}} from req.org, which the contract relies on', () => {
    const controller = readFileSync(join(__dirname, '..', 'routes', 'v1', 'public.integrations.controller.ts'), 'utf8');
    expect(controller).toContain('organization: { id: org.id, name: org.name }');
  });
});

// ---- the schema --------------------------------------------------------------------------------------------------------------

describe('schema.prisma', () => {
  const schema = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', 'libraries', 'nestjs-libraries', 'src', 'database', 'prisma', 'schema.prisma'),
    'utf8'
  );
  const org = /model Organization \{([\s\S]*?)\n\}/.exec(schema)![1];

  it('adds one nullable unique externalRef column to Organization', () => {
    const lines = org.split('\n').filter((l) => /externalRef/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/externalRef\s+String\?\s+@unique/);
  });
});
