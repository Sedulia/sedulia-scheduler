import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { FakePrisma } from '@gitroom/nestjs-libraries/database/prisma/retention/test-support/fake.prisma';

// "We delete your access token when you disconnect an account or delete your workspace": the token and the
// refresh token are emptied, never hashed, at a provider Disconnect error, at a channel delete and at a
// workspace closure.

const md5 = (v: string) => createHash('md5').update(v).digest('hex');
let uploads: string;

const channel = (id: string, org: string, extra: Record<string, any> = {}) => ({
  id,
  organizationId: org,
  internalId: `${id}-internal`,
  rootInternalId: `${id}-root`,
  name: `Name ${id}`,
  profile: `profile-${id}`,
  picture: 'https://pics.example.test/a.png',
  token: `token-${id}`,
  refreshToken: `refresh-${id}`,
  refreshNeeded: false,
  deletedAt: null,
  ...extra,
});

const make = () => {
  const prisma = new FakePrisma({
    organization: [
      { id: 'org-1', deletedAt: null },
      { id: 'org-2', deletedAt: null },
    ],
    integration: [
      channel('c1', 'org-1'),
      channel('c2', 'org-1'),
      channel('c3', 'org-2'),
    ],
    post: [
      { id: 'p1', organizationId: 'org-1', integrationId: 'c1', content: 'x', deletedAt: null },
      { id: 'p3', organizationId: 'org-2', integrationId: 'c3', content: 'y', deletedAt: null },
    ],
  } as any);
  const wrap = (model: any) => ({ model });
  const repository = new IntegrationRepository(
    wrap(prisma) as any,
    wrap(prisma) as any,
    wrap(prisma) as any,
    wrap(prisma) as any,
    wrap(prisma) as any,
    wrap(prisma) as any
  );
  return { prisma, repository };
};

const row = (prisma: FakePrisma, id: string) =>
  prisma.data.integration.find((r) => r.id === id)!;

beforeEach(() => {
  uploads = mkdtempSync(join(tmpdir(), 'token-removal-'));
  process.env.STORAGE_PROVIDER = 'local';
  process.env.UPLOAD_DIRECTORY = uploads;
  process.env.FRONTEND_URL = 'https://social.example.test';
});

afterEach(() => rmSync(uploads, { recursive: true, force: true }));

describe('a provider Disconnect error', () => {
  it('leaves the token and the refresh token empty, not hashed', async () => {
    const { prisma, repository } = make();

    await repository.disconnectChannel('org-1', 'c1');

    expect(row(prisma, 'c1').token).toBe('');
    expect(row(prisma, 'c1').refreshToken).toBe('');
    expect(row(prisma, 'c1').refreshNeeded).toBe(true);
  });

  it('touches only that channel of that workspace', async () => {
    const { prisma, repository } = make();

    await repository.disconnectChannel('org-1', 'c1');

    expect(row(prisma, 'c2').token).toBe('token-c2');
    expect(row(prisma, 'c3').token).toBe('token-c3');
    await expect(repository.disconnectChannel('org-2', 'c1')).rejects.toThrow();
    expect(row(prisma, 'c1').deletedAt).toBeNull();
  });
});

describe('a channel delete', () => {
  it('leaves the token and the refresh token empty, not hashed, and marks it deleted', async () => {
    const { prisma, repository } = make();

    await repository.deleteChannel('org-1', 'c1');

    expect(row(prisma, 'c1').token).toBe('');
    expect(row(prisma, 'c1').refreshToken).toBe('');
    expect(row(prisma, 'c1').deletedAt).toBeInstanceOf(Date);
    expect(row(prisma, 'c2').token).toBe('token-c2');
    expect(row(prisma, 'c3').token).toBe('token-c3');
  });
});

describe('a workspace closure', () => {
  it('empties every token of the workspace in one write, before anything else is changed', async () => {
    const { prisma, repository } = make();
    prisma.data.integration.push(channel('c4', 'org-1', { deletedAt: new Date('2026-10-01') }) as any);

    await repository.deleteIntegrationsForAccount('org-1');

    const integrationWrites = prisma.writes.filter((w) => w.table === 'integration');
    expect(integrationWrites[0].op).toBe('updateMany');
    expect(integrationWrites[0].data).toMatchObject({ token: '', refreshToken: '' });
    for (const id of ['c1', 'c2', 'c4']) {
      expect(row(prisma, id).token).toBe('');
      expect(row(prisma, id).refreshToken).toBe('');
      expect(row(prisma, id).token).not.toBe(md5(`token-${id}`));
    }
  });

  it('still hashes the identity fields, so a returning channel is recognized, and marks the posts deleted', async () => {
    const { prisma, repository } = make();

    await repository.deleteIntegrationsForAccount('org-1');

    expect(row(prisma, 'c1')).toMatchObject({
      name: md5('Name c1'),
      internalId: md5('c1-internal'),
      rootInternalId: md5('c1-root'),
      profile: md5('profile-c1'),
      picture: null,
    });
    expect(row(prisma, 'c1').deletedAt).toBeInstanceOf(Date);
    expect(prisma.data.post.find((p) => p.id === 'p1')!.deletedAt).toBeInstanceOf(Date);
  });

  it('never touches another workspace', async () => {
    const { prisma, repository } = make();

    await repository.deleteIntegrationsForAccount('org-1');

    expect(row(prisma, 'c3')).toMatchObject({ token: 'token-c3', refreshToken: 'refresh-c3', deletedAt: null, name: 'Name c3' });
    expect(prisma.data.post.find((p) => p.id === 'p3')!.deletedAt).toBeNull();
  });
});

describe('the network refuses the refresh token (access removed or revoked)', () => {
  it('empties the token and the refresh token and flags the channel for a reconnect', async () => {
    const { prisma, repository } = make();

    await repository.refreshNeeded('org-1', 'c1');

    expect(row(prisma, 'c1')).toMatchObject({ token: '', refreshToken: '', refreshNeeded: true });
    expect(row(prisma, 'c2').token).toBe('token-c2');
  });
});

describe('a one time token login shared by several channels', () => {
  it('never writes a fresh token into a deleted channel of the same login', async () => {
    const { prisma, repository } = make();
    prisma.data.integration.splice(0, prisma.data.integration.length,
      channel('a', 'org-1', { rootInternalId: 'login-1', internalId: 'a-internal', token: '', refreshToken: '', deletedAt: new Date('2026-11-01') }) as any,
      channel('b', 'org-1', { rootInternalId: 'login-1', internalId: 'b-internal' }) as any,
      channel('x', 'org-2', { rootInternalId: 'login-1', internalId: 'x-internal', token: 'tx', refreshToken: 'rx' }) as any,
      channel('y', 'org-2', { rootInternalId: 'login-1', internalId: 'y-internal', token: '', refreshToken: '', deletedAt: new Date('2026-11-02') }) as any,
    );

    await repository.createOrUpdateIntegration(
      undefined, true, 'org-1', 'Name b', undefined, 'social', 'b-internal', 'linkedin', 'fresh-token', 'fresh-refresh', 3600
    );

    expect(row(prisma, 'a')).toMatchObject({ token: '', refreshToken: '' });
    expect(row(prisma, 'y')).toMatchObject({ token: '', refreshToken: '' });
    // a live channel of the same login still receives it
    expect(row(prisma, 'x')).toMatchObject({ token: 'fresh-token', refreshToken: 'fresh-refresh' });
  });
});

describe('a workspace closure and the channel pictures in our own storage', () => {
  it('removes the copy, leaves a picture hosted elsewhere, and never fails the closure on a missing file', async () => {
    const { prisma, repository } = make();
    const dir = join(uploads, '2026', '11');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'avatar.png'), 'bytes');
    row(prisma, 'c1').picture = `${process.env.FRONTEND_URL}/uploads/2026/11/avatar.png`;
    row(prisma, 'c2').picture = `${process.env.FRONTEND_URL}/uploads/2026/11/already-gone.png`;

    await repository.deleteIntegrationsForAccount('org-1');

    expect(existsSync(join(dir, 'avatar.png'))).toBe(false);
    expect(row(prisma, 'c1').picture).toBeNull();
    expect(row(prisma, 'c2').picture).toBeNull();
  });
});

// The picture copy rule: the picture a refresh or a reconnect replaces is removed from our storage.
describe('a refresh or reconnect that brings a new picture', () => {
  const own = (name: string) => {
    const dir = join(uploads, '2026', '11');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), 'bytes');
    return { onDisk: join(dir, name), url: `${process.env.FRONTEND_URL}/uploads/2026/11/${name}` };
  };
  const write = (repository: IntegrationRepository, picture?: string) =>
    repository.createOrUpdateIntegration(
      undefined, false, 'org-1', 'Name c1', picture, 'social', 'c1-internal', 'x', 'fresh-token', 'fresh-refresh', 3600
    );

  it('removes the replaced copy and keeps the new one', async () => {
    const { prisma, repository } = make();
    const old = own('old.png');
    const fresh = own('new.png');
    row(prisma, 'c1').picture = old.url;

    await write(repository, fresh.url);

    expect(row(prisma, 'c1').picture).toBe(fresh.url);
    expect(existsSync(old.onDisk)).toBe(false);
    expect(existsSync(fresh.onDisk)).toBe(true);
  });

  it('keeps the copy when the picture is unchanged or none is given, and a copy another channel still uses', async () => {
    const { prisma, repository } = make();
    const old = own('old.png');
    row(prisma, 'c1').picture = old.url;

    await write(repository, old.url);
    await write(repository, undefined);
    expect(existsSync(old.onDisk)).toBe(true);

    row(prisma, 'c2').picture = old.url;
    await write(repository, own('new.png').url);
    expect(existsSync(old.onDisk)).toBe(true);
  });
});
