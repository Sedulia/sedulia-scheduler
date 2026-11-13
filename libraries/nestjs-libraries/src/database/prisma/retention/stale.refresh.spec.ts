import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { FakePrisma } from '@gitroom/nestjs-libraries/database/prisma/retention/test-support/fake.prisma';

// The late refresh rule: a token refresh that lands after the channel was deleted or
// disconnected writes nothing. It does not clear deletedAt or refreshNeeded and it does not put a token
// back. The picture copy rule: a refresh leaves no orphaned picture copy in our storage.

// The provider registry, the service and Temporal pull in every network's code; the refresh only needs
// what is passed in below.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

let uploads: string;

const picture = (name: string) => {
  const dir = join(uploads, '2026', '11');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), 'bytes');
  return `${process.env.FRONTEND_URL}/uploads/2026/11/${name}`;
};

const make = (during?: (repository: IntegrationRepository) => Promise<unknown>) => {
  const prisma = new FakePrisma({
    organization: [{ id: 'org-1', deletedAt: null }],
    integration: [
      {
        id: 'c1',
        organizationId: 'org-1',
        internalId: 'c1-internal',
        rootInternalId: 'c1-internal',
        name: 'Name c1',
        providerIdentifier: 'x',
        picture: picture('c1.png'),
        token: 'old-token',
        refreshToken: 'old-refresh',
        refreshNeeded: false,
        inBetweenSteps: false,
        deletedAt: null,
      },
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

  // the network answers the refresh only after `during` ran: the delete or the disconnect lands first
  const provider = {
    oneTimeToken: false,
    refreshToken: async () => {
      if (during) {
        await during(repository);
      }
      return { accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresIn: 3600 };
    },
  };
  const manager = { getSocialIntegration: () => provider };
  // IntegrationService.createOrUpdateIntegration as it runs in production: it uploads a fresh copy of the
  // picture it is handed, then writes through the repository
  let copies = 0;
  const integrationService = {
    refreshNeeded: (org: string, id: string) => repository.refreshNeeded(org, id),
    informAboutRefreshError: async () => undefined,
    createOrUpdateIntegration: async (...args: any[]) => {
      const copy = args[4] ? picture(`copy-${++copies}.png`) : undefined;
      return repository.createOrUpdateIntegration(
        args[0], args[1], args[2], args[3], copy, args[5], args[6], args[7], args[8], args[9], args[10]
      );
    },
  };
  const service = new (RefreshIntegrationService as any)(
    manager,
    integrationService,
    {},
    repository
  ) as RefreshIntegrationService;

  const row = () => prisma.data.integration.find((r) => r.id === 'c1')!;
  return { prisma, repository, service, row, snapshot: () => ({ ...row() }) };
};

beforeEach(() => {
  uploads = mkdtempSync(join(tmpdir(), 'stale-refresh-'));
  process.env.STORAGE_PROVIDER = 'local';
  process.env.UPLOAD_DIRECTORY = uploads;
  process.env.FRONTEND_URL = 'https://social.example.test';
});

afterEach(() => rmSync(uploads, { recursive: true, force: true }));

describe('a token refresh on a live channel', () => {
  it('stores the new tokens', async () => {
    const { service, row, snapshot } = make();

    const result = await service.refresh(snapshot() as any);

    expect(result).toBeTruthy();
    expect(row()).toMatchObject({
      token: 'fresh-token',
      refreshToken: 'fresh-refresh',
      refreshNeeded: false,
      deletedAt: null,
    });
    expect(row().tokenExpiration).toBeInstanceOf(Date);
  });

  it('leaves exactly one picture copy in our storage, the one the channel points at', async () => {
    const { service, row, snapshot } = make();

    await service.refresh(snapshot() as any);

    const onDisk = readdirSync(join(uploads, '2026', '11'));
    expect(onDisk).toHaveLength(1);
    expect(row().picture).toBe(`${process.env.FRONTEND_URL}/uploads/2026/11/${onDisk[0]}`);
  });
});

describe('a token refresh that lands after the channel was deleted', () => {
  it('writes nothing: the channel stays deleted and keeps no token', async () => {
    const { service, row, snapshot } = make((repository) =>
      repository.deleteChannel('org-1', 'c1')
    );

    const result = await service.refresh(snapshot() as any);

    expect(result).toBe(false);
    expect(row().deletedAt).toBeInstanceOf(Date);
    expect(row()).toMatchObject({ token: '', refreshToken: '' });
  });
});

describe('a token refresh that lands after the channel was disconnected', () => {
  it('writes nothing: the channel still needs a reconnect and keeps no token', async () => {
    const { service, row, snapshot } = make((repository) =>
      repository.disconnectChannel('org-1', 'c1')
    );

    const result = await service.refresh(snapshot() as any);

    expect(result).toBe(false);
    expect(row()).toMatchObject({ token: '', refreshToken: '', refreshNeeded: true });
    expect(existsSync(join(uploads, '2026', '11', 'c1.png'))).toBe(true);
  });
});
