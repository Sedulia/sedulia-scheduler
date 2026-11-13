// Tests for Meta's data deletion and deauthorize callbacks and the deletion status page.
// Prisma is an in-memory stand-in (the retention tests' FakePrisma); nothing here opens a database, runs
// prisma generate or db push.
// Run from the repository root:  node_modules/.bin/jest -c apps/backend/jest.config.cjs apps/backend/src/meta-callbacks

jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ removeFile: async () => undefined }) },
}));

import { createCipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { RetentionService, REQUEST_DAYS } from '@gitroom/nestjs-libraries/database/prisma/retention/retention.service';
import { issueDeletionCode, readDeletionCode } from '@gitroom/nestjs-libraries/database/prisma/retention/deletion.code';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { FakePrisma } from '@gitroom/nestjs-libraries/database/prisma/retention/test-support/fake.prisma';
import { MetaCallbacksController } from '@gitroom/backend/meta-callbacks/meta-callbacks.controller';
import { MetaCallbacksService } from '@gitroom/backend/meta-callbacks/meta-callbacks.service';

const APP_SECRET = 'a-facebook-app-secret-for-tests-only';
const JWT = 'a-test-jwt-secret-that-is-long-enough';
const USER = '1234567890123';
const OTHER_USER = '9999999999999';
const BACKEND = 'https://backend.example.test/api';
const DAY = 24 * 60 * 60 * 1000;
const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');

// ---- Meta's signed_request, built the way Meta builds it -----------------------------------------------------------

const payloadOf = (over: Record<string, unknown> = {}) => ({
  algorithm: 'HMAC-SHA256',
  issued_at: Math.floor(Date.now() / 1000),
  user_id: USER,
  ...over,
});
const sign = (payload: unknown, secret = APP_SECRET) => {
  const encoded = b64(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return `${b64(createHmac('sha256', secret).update(encoded).digest())}.${encoded}`;
};

// ---- the rows ------------------------------------------------------------------------------------------------------

const channel = (id: string, org: string, root: string, provider: string, extra: Record<string, any> = {}): Record<string, any> => ({
  id,
  organizationId: org,
  internalId: `${id}-internal`,
  rootInternalId: root,
  providerIdentifier: provider,
  name: `Channel ${id}`,
  profile: `profile-${id}`,
  picture: null,
  token: `token-${id}`,
  refreshToken: `refresh-${id}`,
  refreshNeeded: false,
  deletedAt: null,
  ...extra,
});

const seed = () => ({
  organization: [
    { id: 'org-1', deletedAt: null as Date | null },
    { id: 'org-2', deletedAt: null as Date | null },
  ],
  integration: [
    channel('fb1', 'org-1', USER, 'facebook'),
    channel('ig1', 'org-1', USER, 'instagram'),
    channel('fb2', 'org-2', USER, 'facebook'), // the same person, a second workspace
    channel('fbo', 'org-1', OTHER_USER, 'facebook'), // another person's page
    channel('tt1', 'org-1', USER, 'tiktok'), // another network that happens to hold the same id
    channel('igs', 'org-1', USER, 'instagram-standalone'), // a different Meta app, a different secret
  ],
  post: [
    { id: 'p1', organizationId: 'org-1', integrationId: 'fb1', content: 'hello', deletedAt: null as Date | null },
    { id: 'p2', organizationId: 'org-1', integrationId: 'fbo', content: 'other', deletedAt: null },
  ],
});

// ---- the app -------------------------------------------------------------------------------------------------------

let prisma: FakePrisma;
let app: INestApplication;
let base: string;
let retention: RetentionService;
const ENV = ['FACEBOOK_APP_SECRET', 'JWT_SECRET', 'NEXT_PUBLIC_BACKEND_URL', 'UPLOAD_DIRECTORY'];
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  process.env.FACEBOOK_APP_SECRET = APP_SECRET;
  process.env.JWT_SECRET = JWT;
  process.env.NEXT_PUBLIC_BACKEND_URL = BACKEND;
  process.env.UPLOAD_DIRECTORY = '/tmp/meta-callbacks-test-uploads';
  prisma = new FakePrisma(seed() as any);
  const moduleRef = await Test.createTestingModule({
    controllers: [MetaCallbacksController],
    providers: [MetaCallbacksService, RetentionService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  retention = moduleRef.get(RetentionService);
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterEach(async () => {
  await app.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

interface Resp { status: number; text: string; json: any; headers: Headers }
async function post(path: string, signed: unknown, kind: 'form' | 'json' = 'form'): Promise<Resp> {
  const form = kind === 'form';
  const res = await fetch(base + '/meta-callbacks' + path, {
    method: 'POST',
    headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form
      ? signed === undefined
        ? ''
        : new URLSearchParams({ signed_request: String(signed) }).toString()
      : JSON.stringify(signed === undefined ? {} : { signed_request: signed }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}
const get = async (path: string): Promise<Resp> => {
  const res = await fetch(base + path);
  const text = await res.text();
  return { status: res.status, text, json: null, headers: res.headers };
};
const deletion = (signed: unknown, kind: 'form' | 'json' = 'form') => post('/data-deletion', signed, kind);
const deauth = (signed: unknown) => post('/deauthorize', signed);
const row = (id: string) => prisma.data.integration.find((r) => r.id === id)!;
const writes = () => prisma.writes.length;

// ---- the signature: an unsigned, wrongly signed or stale request deletes nothing --------------------------------------

describe('signature', () => {
  const REFUSED = [
    ['a bad signature', () => `${b64('x'.repeat(32))}.${sign(payloadOf()).split('.')[1]}`],
    ['the signature of another secret', () => sign(payloadOf(), 'some-other-secret')],
    ['a signature over the decoded JSON, not over the encoded part', () => {
      const json = JSON.stringify(payloadOf());
      return `${b64(createHmac('sha256', APP_SECRET).update(json).digest())}.${b64(json)}`;
    }],
    ['a signature over the signature part', () => {
      const sig = b64(createHmac('sha256', APP_SECRET).update('x').digest());
      return `${b64(createHmac('sha256', APP_SECRET).update(sig).digest())}.${b64(JSON.stringify(payloadOf()))}`;
    }],
    ['a payload changed after signing', () => {
      const [sig] = sign(payloadOf()).split('.');
      return `${sig}.${b64(JSON.stringify(payloadOf({ user_id: OTHER_USER })))}`;
    }],
    ['an algorithm other than HMAC-SHA256, validly signed', () => sign(payloadOf({ algorithm: 'HMAC-SHA1' }))],
    ['an algorithm in the wrong case, validly signed', () => sign(payloadOf({ algorithm: 'hmac-sha256' }))],
    ['no algorithm, validly signed', () => sign({ issued_at: Math.floor(Date.now() / 1000), user_id: USER })],
    ['the algorithm none, no signature', () => `.${b64(JSON.stringify(payloadOf({ algorithm: 'none' })))}`],
  ] as const;

  it.each(REFUSED)('refuses %s with a 4xx and deletes nothing', async (_label, make) => {
    const before = prisma.snapshot();
    for (const call of [deletion, deauth]) {
      const r = await call(make());
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.json?.confirmation_code).toBeUndefined();
    }
    expect(prisma.snapshot()).toEqual(before);
    expect(writes()).toBe(0);
  });

  const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
    ['no signed_request', undefined],
    ['an empty signed_request', ''],
    ['a body with no dot', 'abcdef'],
    ['three parts', `${sign(payloadOf())}.extra`],
    ['an empty signature part', `.${b64('{}')}`],
    ['an empty payload part', `${b64('sig')}.`],
    ['characters outside base64url', `${b64('sig')}.${'!@#$'.repeat(8)}`],
    ['a payload that is not JSON, validly signed', sign('this is not json')],
    ['a payload that is a JSON array, validly signed', sign([1, 2, 3])],
    ['a payload that is JSON null, validly signed', sign('null')],
    ['no user_id, validly signed', sign(payloadOf({ user_id: undefined }))],
    ['a user_id that is not digits, validly signed', sign(payloadOf({ user_id: '1 OR 1=1' }))],
    ['a user_id that is an object, validly signed', sign(payloadOf({ user_id: { $ne: '' } }))],
    ['a very long signed_request', 'a'.repeat(100_000)],
  ];

  it.each(MALFORMED)('refuses %s with a 4xx and deletes nothing', async (_label, value) => {
    const before = prisma.snapshot();
    for (const call of [deletion, deauth]) {
      const r = await call(value as any);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect(prisma.snapshot()).toEqual(before);
    expect(writes()).toBe(0);
  });

  it('refuses a signed_request that is not a string (an array or an object in a JSON body)', async () => {
    const before = prisma.snapshot();
    for (const value of [[sign(payloadOf())], { a: sign(payloadOf()) }, 7, null]) {
      for (const path of ['/data-deletion', '/deauthorize']) {
        const r = await post(path, value, 'json');
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
      }
    }
    expect(prisma.snapshot()).toEqual(before);
  });

  it.each([['unset', undefined], ['empty', '']])(
    'refuses everything while FACEBOOK_APP_SECRET is %s, even a request signed with an empty key',
    async (_label, value) => {
      if (value === undefined) delete process.env.FACEBOOK_APP_SECRET;
      else process.env.FACEBOOK_APP_SECRET = value;
      const before = prisma.snapshot();
      for (const secret of ['', 'undefined', APP_SECRET]) {
        for (const call of [deletion, deauth]) {
          const r = await call(sign(payloadOf(), secret));
          expect(r.status).toBeGreaterThanOrEqual(400);
          expect(r.status).toBeLessThan(500);
        }
      }
      expect(prisma.snapshot()).toEqual(before);
      expect(writes()).toBe(0);
    }
  );

  const now = () => Math.floor(Date.now() / 1000);
  it.each([
    ['two hours old', now() - 2 * 3600],
    ['a day old', now() - 86400],
    ['from an hour in the future', now() + 3600],
    ['issued at zero', 0],
  ])('refuses a request issued %s and deletes nothing', async (_label, issued_at) => {
    const before = prisma.snapshot();
    for (const call of [deletion, deauth]) {
      const r = await call(sign(payloadOf({ issued_at })));
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect(prisma.snapshot()).toEqual(before);
  });

  it.each([['missing', undefined], ['a string', 'now'], ['a float NaN as text', 'NaN'], ['an object', {}]])(
    'refuses an issued_at that is %s',
    async (_label, issued_at) => {
      const r = await deletion(sign(payloadOf({ issued_at })));
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(writes()).toBe(0);
    }
  );

  it('accepts a request issued a few minutes ago, and one a few seconds ahead (clock skew)', async () => {
    expect((await deletion(sign(payloadOf({ issued_at: now() - 600 })))).status).toBe(200);
    expect((await deauth(sign(payloadOf({ issued_at: now() + 30 })))).status).toBe(200);
  });

  it('refuses before it deletes when no status code can be signed (no JWT_SECRET)', async () => {
    delete process.env.JWT_SECRET;
    const before = prisma.snapshot();
    const r = await deletion(sign(payloadOf()));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(prisma.snapshot()).toEqual(before);
  });
});

// ---- a good deletion request ---------------------------------------------------------------------------------------

describe('data deletion callback', () => {
  it('removes the tokens of that user at once, queues their rows for the purge, and answers {url, confirmation_code}', async () => {
    const t0 = Date.now();
    const r = await deletion(sign(payloadOf()));
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['confirmation_code', 'url']);
    expect(r.json.url).toBe(`${BACKEND}/meta-callbacks/deletion-status/${r.json.confirmation_code}`);
    expect(r.headers.get('content-type')).toMatch(/json/);

    for (const id of ['fb1', 'ig1', 'fb2']) {
      expect(row(id).token).toBe('');
      expect(row(id).refreshToken).toBe('');
      expect(row(id).refreshNeeded).toBe(true);
      // due REQUEST_DAYS after the request: the purge cutoff is 29 days
      const dueIn = row(id).deletedAt.getTime() + 29 * DAY - t0;
      expect(Math.abs(dueIn - REQUEST_DAYS * DAY)).toBeLessThan(60_000);
    }
  });

  it('touches only the integrations of the user Meta named', async () => {
    await deletion(sign(payloadOf()));
    for (const id of ['fbo', 'tt1', 'igs']) {
      expect(row(id).token).toBe(`token-${id}`);
      expect(row(id).refreshToken).toBe(`refresh-${id}`);
      expect(row(id).deletedAt).toBeNull();
      expect(row(id).refreshNeeded).toBe(false);
    }
    expect(prisma.data.post).toHaveLength(2);
    expect(prisma.data.organization.every((o) => o.deletedAt === null)).toBe(true);
  });

  it('accepts the form encoding Meta sends and a JSON body', async () => {
    expect((await deletion(sign(payloadOf()), 'form')).status).toBe(200);
    expect((await deletion(sign(payloadOf()), 'json')).status).toBe(200);
  });

  it('answers a person with no connected channels with a code and changes nothing', async () => {
    const before = prisma.snapshot();
    const r = await deletion(sign(payloadOf({ user_id: '5550000000001' })));
    expect(r.status).toBe(200);
    expect(r.json.confirmation_code).toBeTruthy();
    expect(prisma.snapshot()).toEqual(before);
  });

  it('is safe to repeat: the second request keeps the first request date', async () => {
    await deletion(sign(payloadOf()));
    const first = row('fb1').deletedAt.getTime();
    const second = await deletion(sign(payloadOf()));
    expect(second.status).toBe(200);
    expect(row('fb1').deletedAt.getTime()).toBeLessThanOrEqual(first);
  });

  it('never leaves the app secret, a token or the user id in the answer', async () => {
    const r = await deletion(sign(payloadOf()));
    for (const secret of [APP_SECRET, JWT, 'token-fb1', 'refresh-fb1']) {
      expect(r.text).not.toContain(secret);
    }
  });
});

describe('deauthorize callback', () => {
  it('removes the tokens of that user and queues no deletion', async () => {
    const r = await deauth(sign(payloadOf()));
    expect(r.status).toBe(200);
    for (const id of ['fb1', 'ig1', 'fb2']) {
      expect(row(id).token).toBe('');
      expect(row(id).refreshToken).toBe('');
      expect(row(id).refreshNeeded).toBe(true);
      expect(row(id).deletedAt).toBeNull();
    }
    expect(prisma.data.post).toHaveLength(2);
  });

  it('touches only the integrations of the user Meta named', async () => {
    await deauth(sign(payloadOf()));
    for (const id of ['fbo', 'tt1', 'igs']) {
      expect(row(id).token).toBe(`token-${id}`);
      expect(row(id).refreshNeeded).toBe(false);
    }
  });

  it('answers a person with no connected channels with a 200 and changes nothing', async () => {
    const before = prisma.snapshot();
    expect((await deauth(sign(payloadOf({ user_id: '5550000000001' })))).status).toBe(200);
    expect(prisma.snapshot()).toEqual(before);
  });
});

// ---- the status URL ------------------------------------------------------------------------------------------------

describe('deletion status page', () => {
  const statusOf = async (code: string) => get(`/meta-callbacks/deletion-status/${code}`);
  const words = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  it('says pending while the request is queued, and done once the purge has run', async () => {
    const { json } = await deletion(sign(payloadOf()));
    const pending = await statusOf(json.confirmation_code);
    expect(pending.status).toBe(200);
    expect(pending.text).toMatch(/Pending/);
    expect(pending.text).not.toMatch(/Done/i);

    await retention.purgeExpired(new Date(Date.now() + 29 * DAY));
    expect(prisma.data.integration.filter((i) => ['fb1', 'ig1', 'fb2'].includes(i.id))).toHaveLength(0);
    const done = await statusOf(json.confirmation_code);
    expect(done.status).toBe(200);
    expect(done.text).toMatch(/Done/);
    expect(done.text).not.toMatch(/Pending/i);
  });

  it('shows only the state: nothing about who asked, what was connected or the code itself', async () => {
    const { json } = await deletion(sign(payloadOf()));
    for (const res of [await statusOf(json.confirmation_code), await (async () => {
      await retention.purgeExpired(new Date(Date.now() + 29 * DAY));
      return statusOf(json.confirmation_code);
    })()]) {
      expect(res.text).not.toContain(USER);
      expect(res.text).not.toContain('org-1');
      expect(res.text).not.toContain('Channel ');
      expect(res.text).not.toContain(json.confirmation_code);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
      expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
      expect(words(res.text.replace(/<title>[^<]*<\/title>/, ''))).toMatch(/^(Pending|Done)( [A-Za-z0-9 .,'-]*)?$/);
    }
  });

  it('is a 404 for a forged code, and the same 404 for every kind of forgery', async () => {
    const good = (await deletion(sign(payloadOf()))).json.confirmation_code as string;
    const flipAt = (c: string, i: number) => c.slice(0, i) + (c[i] === 'A' ? 'B' : 'A') + c.slice(i + 1);
    const underOtherKey = (secret: string) => {
      const k = createHash('sha256').update(secret).digest();
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', k, iv);
      const sealed = Buffer.concat([c.update(JSON.stringify({ k: 'p', r: USER, i: 1 })), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), sealed]).toString('base64url');
    };
    const forged = [
      'x',
      'a.b',
      good.slice(0, -1),
      good.slice(0, 20),
      good + good,
      flipAt(good, 0),
      flipAt(good, 15), // the tag
      flipAt(good, good.length - 3), // the sealed payload
      underOtherKey(JWT), // the right shape, a key that is not the derived one
      underOtherKey('anything else'),
      'A'.repeat(good.length),
      'a'.repeat(5000),
    ];
    const answers = await Promise.all(forged.map((c) => statusOf(encodeURIComponent(c))));
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(a.text).not.toMatch(/Pending|Done/);
    }
    expect(answers.map((a) => words(a.text)).filter((w, i, all) => w !== all[0])).toEqual([]);
  });

  it('is a 404 for a code signed under another JWT_SECRET', async () => {
    const { json } = await deletion(sign(payloadOf()));
    process.env.JWT_SECRET = 'a-completely-different-jwt-secret-value';
    expect((await statusOf(json.confirmation_code)).status).toBe(404);
  });

  it('is a 404 while JWT_SECRET is unset', async () => {
    const { json } = await deletion(sign(payloadOf()));
    delete process.env.JWT_SECRET;
    expect((await statusOf(json.confirmation_code)).status).toBe(404);
  });

  it('keeps two requests apart: a code names its own request only', async () => {
    const a = (await deletion(sign(payloadOf()))).json.confirmation_code;
    const b = (await deletion(sign(payloadOf({ user_id: OTHER_USER })))).json.confirmation_code;
    expect(a).not.toBe(b);
    await retention.purgeExpired(new Date(Date.now() + 29 * DAY));
    expect((await statusOf(a)).text).toMatch(/Done/);
    expect((await statusOf(b)).text).toMatch(/Done/);
  });

  describe('a workspace closure, on the same page', () => {
    it('says pending until the purge has removed the workspace content, then done', async () => {
      const code = issueDeletionCode('workspace', 'org-1');
      expect(readDeletionCode(code)).toMatchObject({ kind: 'workspace', ref: 'org-1' });

      // the workspace is still open: a code was issued, nothing is closed
      expect((await statusOf(code)).text).toMatch(/Pending/);

      prisma.data.organization.find((o) => o.id === 'org-1')!.deletedAt = new Date();
      expect((await statusOf(code)).text).toMatch(/Pending/);

      // the 29 day cutoff passes (the workspace was closed 30 days ago)
      prisma.data.organization.find((o) => o.id === 'org-1')!.deletedAt = new Date(Date.now() - 30 * DAY);
      expect((await statusOf(code)).text).toMatch(/Pending/); // due, but the daily purge has not run
      await retention.purgeExpired(new Date());
      expect(prisma.data.post.filter((p) => p.organizationId === 'org-1')).toHaveLength(0);
      expect((await statusOf(code)).text).toMatch(/Done/);
    });

    it('is not done on the closure day for a workspace with nothing in it', async () => {
      prisma.data.integration = [];
      prisma.data.post = [];
      prisma.data.organization.find((o) => o.id === 'org-2')!.deletedAt = new Date();
      expect((await statusOf(issueDeletionCode('workspace', 'org-2'))).text).toMatch(/Pending/);
    });

    it('is a 404 for a workspace that does not exist', async () => {
      expect((await statusOf(issueDeletionCode('workspace', 'org-none'))).status).toBe(404);
    });
  });
});

// ---- the codes ----------------------------------------------------------------------------------------------------

describe('deletion code', () => {
  it('round trips', () => {
    const code = issueDeletionCode('person', USER, new Date(1_700_000_000_000));
    expect(readDeletionCode(code)).toEqual({ kind: 'person', ref: USER, issuedAt: 1_700_000_000 });
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries no identifier and no secret, in the text or once decoded', () => {
    for (const [kind, ref] of [['person', USER], ['workspace', 'org-1']] as const) {
      const code = issueDeletionCode(kind, ref);
      const decoded = Buffer.from(code, 'base64url');
      for (const needle of [ref, JWT, APP_SECRET, '"r"', 'person', 'workspace']) {
        expect(code).not.toContain(needle);
        expect(decoded.toString('latin1')).not.toContain(needle);
        expect(decoded.toString('utf8')).not.toContain(needle);
      }
    }
  });

  it('is different every time, even for the same request', () => {
    expect(issueDeletionCode('person', USER)).not.toBe(issueDeletionCode('person', USER));
  });

  it('opens only under the key derived from JWT_SECRET', () => {
    const code = issueDeletionCode('person', USER);
    process.env.JWT_SECRET = 'another-jwt-secret-of-the-same-sort';
    expect(readDeletionCode(code)).toBeNull();
  });

  it('refuses to issue a code with no JWT_SECRET', () => {
    delete process.env.JWT_SECRET;
    expect(() => issueDeletionCode('person', USER)).toThrow();
  });

  it('never throws on what it reads', () => {
    for (const v of [undefined, null, 7, {}, '', ' ', '%%%', 'A', 'A'.repeat(40), 'A'.repeat(600)]) {
      expect(readDeletionCode(v as any)).toBeNull();
    }
  });
});

// ---- a page reconnected by another admin ---------------------------------------------------------------------------

describe('a page that another admin reconnected', () => {
  const wrap = (model: any) => ({ model });
  const repository = () =>
    new IntegrationRepository(
      wrap(prisma) as any, wrap(prisma) as any, wrap(prisma) as any,
      wrap(prisma) as any, wrap(prisma) as any, wrap(prisma) as any
    );
  // the connect controller's reconnect: the same page, a token from the login of OTHER_USER
  const reconnect = (provider: string, loginId?: string) =>
    repository().createOrUpdateIntegration(
      undefined, false, 'org-1', 'Page', undefined, 'social', 'fb1-internal', provider,
      'B-token', 'B-refresh', 3600, '', false, 'fb1-internal', undefined, undefined, loginId
    );

  it('names the new login on the row, so the first admin\'s request no longer touches it and the second admin\'s does', async () => {
    await reconnect('facebook', OTHER_USER);
    expect(row('fb1').rootInternalId).toBe(OTHER_USER);
    expect(row('fb1').token).toBe('B-token');

    await deletion(sign(payloadOf())); // the first admin asks
    expect(row('fb1').token).toBe('B-token');
    expect(row('fb1').deletedAt).toBeNull();

    await deletion(sign(payloadOf({ user_id: OTHER_USER }))); // the second admin asks
    expect(row('fb1').token).toBe('');
    expect(row('fb1').deletedAt).not.toBeNull();
  });

  it('works the same for deauthorize', async () => {
    await reconnect('instagram', OTHER_USER);
    await deauth(sign(payloadOf()));
    expect(row('fb1').token).toBe('B-token');
    await deauth(sign(payloadOf({ user_id: OTHER_USER })));
    expect(row('fb1').token).toBe('');
  });

  it('changes nothing for a reconnect that names no login (every other network, and a refresh)', async () => {
    await reconnect('facebook');
    expect(row('fb1').rootInternalId).toBe(USER);
  });
});

// ---- closed workspaces and hashed rows ----------------------------------------------------------------------------

describe('a workspace that closed', () => {
  const md5 = (v: string) => createHash('md5').update(v).digest('hex');
  const hashed = (id: string, org: string, extra: Record<string, any> = {}) =>
    channel(id, org, md5(USER), 'facebook', {
      name: md5(`Channel ${id}`),
      internalId: md5(`${id}-internal`),
      token: '',
      refreshToken: '',
      deletedAt: new Date(Date.now() - 2 * DAY),
      ...extra,
    });
  const statusOf = (code: string) => get(`/meta-callbacks/deletion-status/${code}`);

  beforeEach(() => {
    // the person deleted their account: workspace org-3 closed two days ago, its channel rows were hashed
    prisma.data.organization.push({ id: 'org-3', deletedAt: new Date(Date.now() - 2 * DAY), apiKey: null } as any);
    prisma.data.integration.push(hashed('h1', 'org-3') as any);
    prisma.data.post.push({ id: 'p3', organizationId: 'org-3', integrationId: 'h1', content: 'x', deletedAt: null } as any);
  });

  it('is found by the hash of the user id: its rows are emptied, queued, and the status stays pending until the purge', async () => {
    const { json } = await deletion(sign(payloadOf()));
    expect(row('h1').deletedAt.getTime()).toBeLessThanOrEqual(Date.now() - 2 * DAY + 1000); // an earlier date stands
    expect(row('h1').refreshNeeded).toBe(true);
    expect((await statusOf(json.confirmation_code)).text).toMatch(/Pending/);

    await retention.purgeExpired(new Date(Date.now() + 29 * DAY));
    expect(row('h1').name).toBe('');
    expect((await statusOf(json.confirmation_code)).text).toMatch(/Done/);
  });

  it('is found by deauthorize too', async () => {
    prisma.data.integration.find((r) => r.id === 'h1')!.token = 'left-over';
    await deauth(sign(payloadOf()));
    expect(row('h1').token).toBe('');
  });

  it('keeps a request pending when the workspace closes after the request (the rows are re-hashed)', async () => {
    const { json } = await deletion(sign(payloadOf()));
    // org-1 closes the next day: its channel rows are hashed, as the account delete does
    for (const r of prisma.data.integration.filter((i) => ['fb1', 'ig1'].includes(i.id))) {
      r.rootInternalId = md5(r.rootInternalId);
      r.name = md5(r.name);
    }
    expect((await statusOf(json.confirmation_code)).text).toMatch(/Pending/);
  });

  it('does not touch another person\'s hashed rows', async () => {
    prisma.data.integration.push(
      hashed('h2', 'org-3', { rootInternalId: md5(OTHER_USER), token: 'theirs', refreshToken: 'theirs' }) as any
    );
    await deletion(sign(payloadOf()));
    expect(row('h2').token).toBe('theirs');
  });

  describe('its status is done only when the purge has left nothing behind', () => {
    const THIRTY_DAYS_AGO = () => new Date(Date.now() - 30 * DAY);
    const setup = () => {
      prisma.data.organization.find((o) => o.id === 'org-3')!.deletedAt = THIRTY_DAYS_AGO();
      prisma.data.integration = prisma.data.integration.filter((i) => i.organizationId !== 'org-3');
      prisma.data.post = prisma.data.post.filter((p) => p.organizationId !== 'org-3');
      prisma.data.user = [{ id: 'u1', ip: '203.0.113.9', agent: 'UA' }] as any;
      prisma.data.userOrganization = [{ userId: 'u1', organizationId: 'org-3' }] as any;
      prisma.data.tags = [{ id: 't1', orgId: 'org-3', name: 'tag' }] as any;
      prisma.data.webhooks = [{ id: 'w1', organizationId: 'org-3' }] as any;
      return issueDeletionCode('workspace', 'org-3');
    };

    it('is pending with no channel, post or media but a tag, a webhook and a member login ip, until the purge removes them', async () => {
      const code = setup();
      expect((await statusOf(code)).text).toMatch(/Pending/);
      await retention.purgeExpired(new Date());
      expect(prisma.data.tags).toHaveLength(0);
      expect(prisma.data.user[0].ip).toBeNull();
      expect((await statusOf(code)).text).toMatch(/Done/);
    });

    it.each([
      ['a tag', () => { prisma.data.tags = [{ id: 't1', orgId: 'org-3' }] as any; }],
      ['a webhook', () => { prisma.data.webhooks = [{ id: 'w1', organizationId: 'org-3' }] as any; }],
      ['a login ip', () => { prisma.data.user = [{ id: 'u1', ip: '203.0.113.9', agent: null }] as any; }],
      ['an API key', () => { prisma.data.organization.find((o) => o.id === 'org-3')!.apiKey = 'k' as any; }],
    ])('is pending while %s is left', async (_label, leave) => {
      const code = setup();
      await retention.purgeExpired(new Date());
      leave();
      expect((await statusOf(code)).text).toMatch(/Pending/);
    });

    it('is done for a member who still belongs to an open workspace and keeps a login ip', async () => {
      const code = setup();
      prisma.data.userOrganization.push({ userId: 'u1', organizationId: 'org-1' } as any);
      await retention.purgeExpired(new Date());
      expect(prisma.data.user[0].ip).toBe('203.0.113.9'); // the purge keeps it, so the status must not wait for it
      expect((await statusOf(code)).text).toMatch(/Done/);
    });
  });
});

// ---- the account delete path --------------------------------------------------------------------------------------

describe('account delete path', () => {
  it('issues a status code for each workspace it closes', async () => {
    const orgs = [
      { id: 'org-1', users: [{ role: 'SUPERADMIN' }], subscription: null as any },
      { id: 'org-2', users: [{ role: 'ADMIN' }], subscription: null as any },
    ];
    const orgRepo: any = {
      getOrgsByUserId: async () => orgs,
      getTeam: async () => ({ users: [{ user: { id: 'u1' }, role: 'SUPERADMIN' }] }),
      deleteTeamMember: jest.fn(),
      deleteOrganization: jest.fn(),
    };
    const integrationRepo: any = { deleteIntegrationsForAccount: jest.fn() };
    const usersRepo: any = { deleteAccount: jest.fn() };
    const service = new UsersService(usersRepo, orgRepo, integrationRepo, {} as any);

    const result: any = await service.deleteAccount('u1');
    expect(orgRepo.deleteOrganization).toHaveBeenCalledTimes(1);
    expect(result.deletionCodes).toHaveLength(1);
    expect(readDeletionCode(result.deletionCodes[0])).toMatchObject({ kind: 'workspace', ref: 'org-1' });
  });
});
