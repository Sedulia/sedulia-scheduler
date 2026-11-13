import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import {
  KEPT_ORG_MODELS,
  PURGED_ORG_MODELS,
  PURGE_AFTER_DAYS,
  REQUEST_DAYS,
  RetentionService,
} from '@gitroom/nestjs-libraries/database/prisma/retention/retention.service';
import { FakePrisma } from '@gitroom/nestjs-libraries/database/prisma/retention/test-support/fake.prisma';

// The retention promises of the Terms and Privacy policy:
// content is kept while a workspace is open and purged within 30 days after closure (a 29 day cutoff,
// see the cutoff rule below); a deleted channel's rows go the same way; tokens are already gone by then. Prisma is an in-memory fake that enforces the
// schema's foreign keys; the uploads folder is a real temporary directory.

const NOW = new Date('2026-12-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SECRET_BODY = 'PRIVATE POST BODY 7731';
const SECRET_TOKEN = 'ACCESS-TOKEN-7731';
const SECRET_REFRESH = 'REFRESH-TOKEN-7731';
const md5 = (v: string) => createHash('md5').update(v).digest('hex');
const SECRET_EMAIL = 'someone-7731@customer.example';

let uploads: string;

const file = (name: string) => {
  const dir = join(uploads, '2026', '11');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), 'bytes');
  return {
    onDisk: join(dir, name),
    url: `${process.env.FRONTEND_URL}/uploads/2026/11/${name}`,
  };
};

// One workspace with one channel, a post with a comment, an error and a tag link, one media row with its
// file, and one member user with a login ip and agent.
const workspace = (
  id: string,
  opts: { closedAt?: Date | null; channelDeletedAt?: Date | null } = {}
) => {
  const f = file(`${id}.png`);
  const pic = file(`${id}-avatar.png`);
  const clipFile = file(`${id}-clip.mp4`);
  const clipThumb = file(`${id}-clip.jpg`);
  const rows = {
    organization: [
      {
        id,
        name: `Org ${id}`,
        apiKey: `key-${id}`,
        deletedAt: opts.closedAt ?? null,
      },
    ],
    integration: [
      {
        id: `${id}-ch`,
        organizationId: id,
        internalId: `${id}-internal`,
        token: SECRET_TOKEN,
        refreshToken: SECRET_REFRESH,
        deletedAt: opts.channelDeletedAt ?? opts.closedAt ?? null,
      },
    ],
    post: [
      {
        id: `${id}-post`,
        organizationId: id,
        integrationId: `${id}-ch`,
        content: SECRET_BODY,
        deletedAt: opts.closedAt ?? null,
      },
      {
        id: `${id}-reply`,
        organizationId: id,
        integrationId: `${id}-ch`,
        parentPostId: `${id}-post`,
        content: SECRET_BODY,
        deletedAt: null,
      },
    ],
    comments: [
      { id: `${id}-c1`, organizationId: id, postId: `${id}-post`, content: SECRET_BODY },
      { id: `${id}-c2`, organizationId: id, postId: `${id}-post`, parentId: `${id}-c1`, content: SECRET_BODY },
    ],
    errors: [
      { id: `${id}-e1`, organizationId: id, postId: `${id}-post`, message: SECRET_BODY, body: SECRET_BODY },
    ],
    tagsPosts: [{ postId: `${id}-post`, tagId: `${id}-tag` }],
    media: [
      { id: `${id}-m`, organizationId: id, name: 'a.png', path: f.url, thumbnail: null },
    ],
    user: [
      { id: `${id}-u`, email: SECRET_EMAIL, ip: '203.0.113.9', agent: 'Browser/1', pictureId: null },
    ],
    userOrganization: [{ id: `${id}-uo`, userId: `${id}-u`, organizationId: id }],
    plugs: [{ id: `${id}-pl`, integrationId: `${id}-ch`, organizationId: id }],
    tags: [{ id: `${id}-tag`, orgId: id, name: SECRET_BODY, color: '#fff' }],
    customer: [{ id: `${id}-cust`, orgId: id, name: SECRET_BODY }],
    webhooks: [{ id: `${id}-wh`, organizationId: id, url: SECRET_BODY }],
    integrationsWebhooks: [{ integrationId: `${id}-ch`, webhookId: `${id}-wh` }],
    signatures: [{ id: `${id}-sig`, organizationId: id, content: SECRET_BODY }],
    sets: [{ id: `${id}-set`, organizationId: id, content: SECRET_BODY }],
    autoPost: [{ id: `${id}-ap`, organizationId: id, url: SECRET_BODY }],
    notifications: [{ id: `${id}-n`, organizationId: id, content: SECRET_BODY }],
    thirdParty: [{ id: `${id}-tp`, organizationId: id, apiKey: SECRET_TOKEN }],
    gitHub: [{ id: `${id}-gh`, organizationId: id, token: SECRET_TOKEN }],
    clipping: [{ id: `${id}-clip`, organizationId: id, thumbnail: clipThumb.url }],
    clippingClip: [{ id: `${id}-cc`, clippingId: `${id}-clip`, path: clipFile.url, thumbnail: null }],
    oAuthApp: [{ id: `${id}-app`, organizationId: id, clientSecret: SECRET_TOKEN, pictureId: null }],
    oAuthAuthorization: [{ id: `${id}-oa`, organizationId: id, oauthAppId: `${id}-app`, accessToken: SECRET_TOKEN }],
  };
  rows.integration[0].picture = pic.url;
  return { rows, file: f, extraFiles: [pic.onDisk, clipFile.onDisk, clipThumb.onDisk] };
};

const merge = (...parts: Record<string, any[]>[]) => {
  const out: Record<string, any[]> = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part)) {
      out[k] = [...(out[k] || []), ...v];
    }
  }
  return out;
};

const build = (...ws: ReturnType<typeof workspace>[]) => {
  const prisma = new FakePrisma(merge(...ws.map((w) => w.rows)) as any);
  return { prisma, service: new RetentionService(prisma as any) };
};

const ids = (prisma: FakePrisma, table: string) =>
  prisma.data[table].map((r) => r.id).sort();

let logged: string[];

beforeEach(() => {
  uploads = mkdtempSync(join(tmpdir(), 'retention-uploads-'));
  process.env.STORAGE_PROVIDER = 'local';
  process.env.UPLOAD_DIRECTORY = uploads;
  process.env.FRONTEND_URL = 'https://social.example.test';
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: any) => void logged.push(String(message)));
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(uploads, { recursive: true, force: true });
});

describe('daily purge: a closed workspace', () => {
  it('hard deletes everything 29 days after closure, and its users login ip and agent', async () => {
    const closed = workspace('closed', { closedAt: ago(29 * DAY) });
    const { prisma, service } = build(closed);

    const counts = await service.purgeExpired(NOW);

    for (const table of [
      'post', 'comments', 'errors', 'media', 'tagsPosts', 'plugs', 'tags', 'customer',
      'webhooks', 'integrationsWebhooks', 'signatures', 'sets', 'autoPost', 'notifications', 'thirdParty',
      'gitHub', 'clipping', 'clippingClip', 'oAuthAuthorization',
    ]) {
      expect(prisma.data[table]).toEqual([]);
    }
    // the channel stays only as a hashed shell for the trial check (the kept history rule): no token, no content
    expect(prisma.data.integration).toEqual([
      expect.objectContaining({ id: 'closed-ch', token: '', refreshToken: '', name: '', picture: null, profile: null }),
    ]);
    // the OAuth app definition stays, its secret does not
    expect(prisma.data.oAuthApp).toEqual([expect.objectContaining({ id: 'closed-app', clientSecret: null })]);
    expect(existsSync(closed.file.onDisk)).toBe(false);
    // the channel picture copy, the clip file and the clip thumbnail go too
    for (const f of closed.extraFiles) {
      expect(existsSync(f)).toBe(false);
    }
    expect(prisma.data.user[0]).toMatchObject({ ip: null, agent: null });
    expect(prisma.data.organization[0].apiKey).toBeNull();
    expect(counts).toMatchObject({
      workspaces: 1,
      channels: 1,
      posts: 2,
      comments: 2,
      errors: 1,
      media: 1,
      files: 4,
      users: 1,
      failures: 0,
    });
  });

  it('is not purged before the 29 day cutoff', async () => {
    const closed = workspace('closed', { closedAt: ago(29 * DAY - 60 * 1000) });
    const { prisma, service } = build(closed);
    const before = prisma.snapshot();

    const counts = await service.purgeExpired(NOW);

    // the swept tokens are the only change inside the window
    const after = prisma.snapshot();
    after.integration[0].token = before.integration[0].token;
    after.integration[0].refreshToken = before.integration[0].refreshToken;
    expect(after).toEqual(before);
    expect(existsSync(closed.file.onDisk)).toBe(true);
    expect(counts.workspaces).toBe(0);
  });

  it('is purged after the cutoff too, not only on the exact day', async () => {
    const closed = workspace('closed', { closedAt: ago(31 * DAY) });
    const { prisma, service } = build(closed);
    await service.purgeExpired(NOW);
    expect(prisma.data.post).toEqual([]);
  });

  it('empties the tokens of a closed workspace inside its 30 days, even if closure missed them', async () => {
    const closed = workspace('closed', { closedAt: ago(3 * DAY) });
    const { prisma, service } = build(closed);

    await service.purgeExpired(NOW);

    expect(prisma.data.integration[0].token).toBe('');
    expect(prisma.data.integration[0].refreshToken).toBe('');
    expect(prisma.data.post).toHaveLength(2);
  });

  it('keeps a user who is still a member of an open workspace', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const open = workspace('open');
    open.rows.user = [];
    open.rows.userOrganization = [
      { id: 'shared-uo', userId: 'closed-u', organizationId: 'open' },
    ];
    const { prisma, service } = build(closed, open);

    await service.purgeExpired(NOW);

    expect(prisma.data.user[0]).toMatchObject({ ip: '203.0.113.9', agent: 'Browser/1' });
  });

  it('leaves a user who also belongs to a workspace that closed less than 30 days ago', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const recent = workspace('recent', { closedAt: ago(2 * DAY) });
    recent.rows.user = [];
    recent.rows.userOrganization = [
      { id: 'shared-uo', userId: 'closed-u', organizationId: 'recent' },
    ];
    const { prisma, service } = build(closed, recent);

    await service.purgeExpired(NOW);

    expect(prisma.data.user[0]).toMatchObject({ ip: '203.0.113.9' });
  });
});

describe('daily purge: a deleted channel', () => {
  it('goes 29 days after its deletion, with its posts, and not a day before', async () => {
    const open = workspace('open', { channelDeletedAt: ago(29 * DAY) });
    const young = workspace('young', { channelDeletedAt: ago(28 * DAY) });
    const { prisma, service } = build(open, young);

    const counts = await service.purgeExpired(NOW);

    expect(ids(prisma, 'integration')).toEqual(['young-ch']);
    expect(ids(prisma, 'post')).toEqual(['young-post', 'young-reply']);
    expect(ids(prisma, 'plugs')).toEqual(['young-pl']);
    expect(counts).toMatchObject({ workspaces: 0, channels: 1, posts: 2, failures: 0 });
  });

  it('leaves the open workspace itself, its media, its other channel and their posts alone', async () => {
    const open = workspace('open', { channelDeletedAt: ago(45 * DAY) });
    open.rows.integration.push({
      id: 'open-live',
      organizationId: 'open',
      internalId: 'live-internal',
      token: SECRET_TOKEN,
      refreshToken: SECRET_REFRESH,
      deletedAt: null,
    } as any);
    open.rows.post.push({
      id: 'live-post',
      organizationId: 'open',
      integrationId: 'open-live',
      content: SECRET_BODY,
      deletedAt: null,
    } as any);
    const { prisma, service } = build(open);

    await service.purgeExpired(NOW);

    expect(ids(prisma, 'integration')).toEqual(['open-live']);
    expect(ids(prisma, 'post')).toEqual(['live-post']);
    expect(ids(prisma, 'media')).toEqual(['open-m']);
    expect(existsSync(open.file.onDisk)).toBe(true);
    expect(ids(prisma, 'organization')).toEqual(['open']);
  });
});

describe('daily purge: an open workspace', () => {
  it('is never touched, tokens included', async () => {
    const open = workspace('open');
    const { prisma, service } = build(open);
    const before = prisma.snapshot();

    const counts = await service.purgeExpired(NOW);

    expect(prisma.snapshot()).toEqual(before);
    expect(prisma.writes.filter((w) => w.table === 'integration' && w.op === 'deleteMany')).toEqual([]);
    expect(existsSync(open.file.onDisk)).toBe(true);
    expect(counts).toMatchObject({ workspaces: 0, channels: 0, posts: 0, media: 0, files: 0, failures: 0 });
  });

  it('is not purged by a closure that has been reopened before the purge runs', async () => {
    // the closed row is read, then the workspace comes back; the purge re-checks before it deletes
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const { prisma, service } = build(closed);
    // a reopened workspace has live channels again
    prisma.data.integration[0].deletedAt = null;
    const original = prisma.organization.findMany;
    prisma.organization.findMany = async (args: any) => {
      const found = await original(args);
      prisma.data.organization[0].deletedAt = null;
      return found;
    };

    const counts = await service.purgeExpired(NOW);

    expect(counts.workspaces).toBe(0);
    expect(ids(prisma, 'post')).toEqual(['closed-post', 'closed-reply']);
    expect(existsSync(closed.file.onDisk)).toBe(true);
  });

  it('keeps the closed workspace when an open one has the same file name', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const open = workspace('open');
    const { prisma, service } = build(closed, open);

    await service.purgeExpired(NOW);

    expect(existsSync(closed.file.onDisk)).toBe(false);
    expect(existsSync(open.file.onDisk)).toBe(true);
    expect(ids(prisma, 'media')).toEqual(['open-m']);
  });
});

describe('daily purge: runs', () => {
  it('is idempotent: a second run changes nothing and counts nothing', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const young = workspace('young', { channelDeletedAt: ago(40 * DAY) });
    const open = workspace('open');
    const { prisma, service } = build(closed, young, open);

    const first = await service.purgeExpired(NOW);
    const afterFirst = prisma.snapshot();
    const second = await service.purgeExpired(NOW);

    expect(first.workspaces).toBe(1);
    expect(prisma.snapshot()).toEqual(afterFirst);
    expect(second).toMatchObject({ channels: 0, posts: 0, comments: 0, errors: 0, media: 0, files: 0, users: 0, failures: 0 });
  });

  it('logs counts, never content', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const open = workspace('open');
    const { service } = build(closed, open);

    await service.purgeExpired(NOW);

    const everything = logged.join('\n');
    expect(everything).toMatch(/workspaces/);
    for (const secret of [SECRET_BODY, SECRET_TOKEN, SECRET_REFRESH, SECRET_EMAIL, '203.0.113.9', 'a.png', 'closed.png']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('treats a file that is already gone as removed', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    rmSync(closed.file.onDisk);
    const { prisma, service } = build(closed);

    const counts = await service.purgeExpired(NOW);

    expect(counts.failures).toBe(0);
    expect(prisma.data.media).toEqual([]);
  });

  it('keeps a workspace whole when one of its files cannot be removed, and finishes it the next day', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    // a directory where the file should be: unlink fails with something other than ENOENT
    rmSync(closed.file.onDisk);
    mkdirSync(closed.file.onDisk);
    const other = workspace('other', { closedAt: ago(40 * DAY) });
    const { prisma, service } = build(closed, other);

    const first = await service.purgeExpired(NOW);

    expect(first.failures).toBe(1);
    // the workspace waits whole: its media row, its api key and its members' login records stay
    expect(ids(prisma, 'media')).toEqual(['closed-m']);
    expect(prisma.data.organization.find((o) => o.id === 'closed')!.apiKey).toBe('key-closed');
    expect(prisma.data.user.find((u) => u.id === 'closed-u')!.ip).toBe('203.0.113.9');
    // the second workspace is not held back by the first
    expect(ids(prisma, 'user')).toEqual(['closed-u', 'other-u']);
    expect(prisma.data.user.find((u) => u.id === 'other-u')!.ip).toBeNull();
    expect(ids(prisma, 'media')).not.toContain('other-m');
    expect(existsSync(other.file.onDisk)).toBe(false);

    rmSync(closed.file.onDisk, { recursive: true });
    const second = await service.purgeExpired(new Date(NOW.getTime() + DAY));

    expect(second.failures).toBe(0);
    expect(prisma.data.media).toEqual([]);
    expect(prisma.data.organization.find((o) => o.id === 'closed')!.apiKey).toBeNull();
    expect(prisma.data.user.find((u) => u.id === 'closed-u')!.ip).toBeNull();
  });

  it('never deletes a file outside the uploads folder', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const outside = join(tmpdir(), `retention-outside-${process.pid}.txt`);
    writeFileSync(outside, 'keep');
    closed.rows.media[0].path = outside;
    const { service } = build(closed);

    await service.purgeExpired(NOW);

    expect(existsSync(outside)).toBe(true);
    rmSync(outside);
  });
});

describe('removeTokensAndQueue: one person at once (for the deletion callback)', () => {
  it('empties every token of the named channels at once and queues their rows for the purge', async () => {
    const a = workspace('a');
    const b = workspace('b');
    const { prisma, service } = build(a, b);
    prisma.data.integration[0].rootInternalId = 'fb-person-1';
    prisma.data.integration[1].rootInternalId = 'fb-person-2';

    const result = await service.removeTokensAndQueue({ rootInternalIds: ['fb-person-1'] }, NOW);

    expect(result).toEqual({ channels: 1 });
    expect(prisma.data.integration[0]).toMatchObject({ token: '', refreshToken: '', deletedAt: new Date(NOW.getTime() - (PURGE_AFTER_DAYS - REQUEST_DAYS) * DAY) });
    expect(prisma.data.integration[1]).toMatchObject({ token: SECRET_TOKEN, refreshToken: SECRET_REFRESH, deletedAt: null });

    // queued: the rows are still there inside the 30 days and gone after them
    await service.purgeExpired(new Date(NOW.getTime() + 20 * DAY));
    expect(ids(prisma, 'integration')).toContain('a-ch');
    await service.purgeExpired(new Date(NOW.getTime() + 30 * DAY));
    expect(ids(prisma, 'integration')).toEqual(['b-ch']);
    expect(ids(prisma, 'post')).toEqual(['b-post', 'b-reply']);
  });

  it('matches by channel id too, keeps the first deletion date, and does nothing with no target', async () => {
    const a = workspace('a', { channelDeletedAt: ago(5 * DAY) });
    const { prisma, service } = build(a);

    expect(await service.removeTokensAndQueue({}, NOW)).toEqual({ channels: 0 });
    expect(await service.removeTokensAndQueue({ integrationIds: [] }, NOW)).toEqual({ channels: 0 });
    expect(prisma.data.integration[0].token).toBe(SECRET_TOKEN);

    await service.removeTokensAndQueue({ integrationIds: ['a-ch'] }, NOW);

    expect(prisma.data.integration[0]).toMatchObject({ token: '', refreshToken: '', deletedAt: ago(5 * DAY) });
  });
});

describe('the purge covers every table a workspace owns', () => {
  it('lists every schema model with an organization column as purged or kept, so none is forgotten', () => {
    const schema = readFileSync(
      join(__dirname, '..', 'schema.prisma'),
      'utf8'
    );
    const models = Array.from(
      schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)
    )
      .filter(([, name]) => !name.startsWith('mastra'))
      .filter(([, , body]) => /^\s+(organizationId|orgId)\s/m.test(body))
      .map(([, name]) => name)
      .sort();

    const decided = [...PURGED_ORG_MODELS, ...KEPT_ORG_MODELS].sort();
    expect(models).toEqual(decided);
  });

  it('runs every transaction with a timeout longer than Prisma default of 5 seconds', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    const { prisma, service } = build(closed);

    await service.purgeExpired(NOW);

    expect(prisma.transactionOptions.length).toBeGreaterThan(0);
    for (const options of prisma.transactionOptions) {
      expect(options.timeout).toBeGreaterThan(5000);
    }
  });
});

describe('a deletion request is done within 30 days', () => {
  it('is gone at the first daily run after REQUEST_DAYS, which is before day 30', async () => {
    const a = workspace('a');
    const { prisma, service } = build(a);
    prisma.data.integration[0].rootInternalId = 'fb-person-1';

    await service.removeTokensAndQueue({ rootInternalIds: ['fb-person-1'] }, NOW);

    await service.purgeExpired(new Date(NOW.getTime() + (REQUEST_DAYS - 1) * DAY));
    expect(ids(prisma, 'integration')).toEqual(['a-ch']);
    // the daily run closest to day 28 is at most a day late: day 29 still precedes day 30
    await service.purgeExpired(new Date(NOW.getTime() + (REQUEST_DAYS + 1) * DAY));
    expect(prisma.data.integration).toEqual([]);
    expect(REQUEST_DAYS + 1).toBeLessThan(30);
  });
});

// The retention rules, one block each.
describe('cutoff rule: the purge runs at a 29 day cutoff, so "within 30 days" stays true', () => {
  it('purges a workspace closed 29 days ago, and not a minute before', async () => {
    const due = workspace('due', { closedAt: ago(29 * DAY) });
    const young = workspace('young', { closedAt: ago(29 * DAY - 60 * 1000) });
    const { prisma, service } = build(due, young);

    const counts = await service.purgeExpired(NOW);

    expect(counts.workspaces).toBe(1);
    expect(ids(prisma, 'post')).toEqual(['young-post', 'young-reply']);
    expect(existsSync(due.file.onDisk)).toBe(false);
    expect(existsSync(young.file.onDisk)).toBe(true);
  });

  it('purges a channel deleted 29 days ago, and not a minute before', async () => {
    const due = workspace('due', { channelDeletedAt: ago(29 * DAY) });
    const young = workspace('young', { channelDeletedAt: ago(29 * DAY - 60 * 1000) });
    const { prisma, service } = build(due, young);

    await service.purgeExpired(NOW);

    expect(ids(prisma, 'integration')).toEqual(['young-ch']);
    expect(ids(prisma, 'post')).toEqual(['young-post', 'young-reply']);
  });
});

describe('picture copy rule: a single deleted channel takes its picture copy with it', () => {
  it('removes the copy in our storage when the channel is purged, and nothing else of the open workspace', async () => {
    const open = workspace('open', { channelDeletedAt: ago(40 * DAY) });
    const [pictureOnDisk] = open.extraFiles;
    const { prisma, service } = build(open);

    const counts = await service.purgeExpired(NOW);

    expect(ids(prisma, 'integration')).toEqual([]);
    expect(existsSync(pictureOnDisk)).toBe(false);
    expect(existsSync(open.file.onDisk)).toBe(true);
    expect(counts.files).toBe(1);
  });

  it('keeps a copy that a live channel still points at', async () => {
    const open = workspace('open', { channelDeletedAt: ago(40 * DAY) });
    const [pictureOnDisk] = open.extraFiles;
    open.rows.integration.push({
      id: 'open-live',
      organizationId: 'open',
      internalId: 'live-internal',
      picture: (open.rows.integration[0] as any).picture,
      token: SECRET_TOKEN,
      refreshToken: SECRET_REFRESH,
      deletedAt: null,
    } as any);
    const { service } = build(open);

    await service.purgeExpired(NOW);

    expect(existsSync(pictureOnDisk)).toBe(true);
  });
});

describe('late request rule: a request queued soon after a channel deletion is done within 30 days', () => {
  it('moves the later deletion date back, so the request is due on the same day as any other', async () => {
    const a = workspace('a', { channelDeletedAt: ago(12 * 60 * 60 * 1000) });
    const { prisma, service } = build(a);
    prisma.data.integration[0].rootInternalId = 'fb-person-1';

    await service.removeTokensAndQueue({ rootInternalIds: ['fb-person-1'] }, NOW);

    await service.purgeExpired(new Date(NOW.getTime() + REQUEST_DAYS * DAY + 60 * 1000));
    expect(prisma.data.integration).toEqual([]);
    expect(prisma.data.post).toEqual([]);
  });
});

describe('kept history rule: the hashed history the trial check reads is kept', () => {
  it('still recognizes a channel of a purged workspace when it connects again elsewhere, and keeps nothing else of it', async () => {
    const closed = workspace('closed', { closedAt: ago(40 * DAY) });
    // as the closure leaves it: identity fields hashed, tokens empty, picture gone
    Object.assign(closed.rows.integration[0], {
      name: md5('Closed Channel'),
      internalId: md5('acct-7731'),
      rootInternalId: md5('acct-7731'),
      profile: md5('closed-handle'),
      customerId: 'closed-cust',
      token: '',
      refreshToken: '',
    });
    const { prisma, service } = build(closed);
    const wrap = (model: any) => ({ model });
    const repository = new IntegrationRepository(
      wrap(prisma) as any, wrap(prisma) as any, wrap(prisma) as any,
      wrap(prisma) as any, wrap(prisma) as any, wrap(prisma) as any
    );

    await service.purgeExpired(NOW);

    expect(await repository.checkPreviousConnections('new-org', 'acct-7731')).toBe(true);
    expect(prisma.data.integration).toHaveLength(1);
    expect(prisma.data.integration[0]).toMatchObject({
      rootInternalId: md5('acct-7731'),
      name: '',
      profile: null,
      picture: null,
      customerId: null,
      token: '',
      refreshToken: '',
    });
    expect(prisma.data.post).toEqual([]);
    expect(prisma.data.customer).toEqual([]);
  });
});
