import { createHash } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { RetentionService } from '@gitroom/nestjs-libraries/database/prisma/retention/retention.service';
import {
  issueDeletionCode,
  readDeletionCode,
} from '@gitroom/nestjs-libraries/database/prisma/retention/deletion.code';
import {
  SignedRequestError,
  verifySignedRequest,
} from '@gitroom/backend/meta-callbacks/signed.request';

// Only these providers sign in through the Facebook app (FACEBOOK_APP_SECRET); every other network, and the
// standalone Instagram app, has its own secret and its own ids.
export const META_PROVIDERS = ['facebook', 'instagram'];

// Closing a workspace replaces each channel's rootInternalId with its md5 (the channel stays a shell for the
// free trial check), so a user's channels are found by the raw id and by its hash.
const rootIds = (userId: string) => [userId, createHash('md5').update(userId).digest('hex')];

export type DeletionState = 'pending' | 'done';

@Injectable()
export class MetaCallbacksService {
  private readonly _logger = new Logger(MetaCallbacksService.name);

  constructor(
    private _prisma: PrismaService,
    private _retention: RetentionService
  ) {}

  // The app scoped user id Meta named, from a request whose signature, algorithm and age all hold.
  // Anything else is a 4xx before a single row is read.
  private userOf(signedRequest: unknown): string {
    try {
      return verifySignedRequest(signedRequest, process.env.FACEBOOK_APP_SECRET).userId;
    } catch (err) {
      const reason = err instanceof SignedRequestError ? err.reason : 'malformed';
      this._logger.warn(`meta callback refused ${JSON.stringify({ reason })}`);
      if (reason === 'signature' || reason === 'stale') {
        throw new ForbiddenException('Invalid request');
      }
      throw new BadRequestException('Invalid request');
    }
  }

  // The integrations Facebook or Instagram connected for that user, in any workspace. A page row keeps the
  // root id of the login that connected it, and that login's id is the app scoped user id.
  private async channelsOf(userId: string): Promise<string[]> {
    const rows = await this._prisma.integration.findMany({
      where: {
        rootInternalId: { in: rootIds(userId) },
        providerIdentifier: { in: META_PROVIDERS },
      },
      select: { id: true },
    });
    return rows.map((r: { id: string }) => r.id);
  }

  async dataDeletion(signedRequest: unknown) {
    const userId = this.userOf(signedRequest);
    // the code is signed first: if it cannot be, nothing is deleted and Meta retries
    let code: string;
    try {
      code = issueDeletionCode('person', userId);
    } catch {
      throw new ServiceUnavailableException('Try again later');
    }
    const integrationIds = await this.channelsOf(userId);
    const { channels } = await this._retention.removeTokensAndQueue({ integrationIds });
    this._logger.log(`meta data deletion ${JSON.stringify({ channels })}`);
    return { url: this.statusUrl(code), confirmation_code: code };
  }

  async deauthorize(signedRequest: unknown) {
    const userId = this.userOf(signedRequest);
    const integrationIds = await this.channelsOf(userId);
    let channels = 0;
    if (integrationIds.length) {
      // the token goes at deauthorization; the content stays while the workspace is open (retention rule)
      ({ count: channels } = await this._prisma.integration.updateMany({
        where: { id: { in: integrationIds } },
        data: { token: '', refreshToken: '', refreshNeeded: true },
      }));
    }
    this._logger.log(`meta deauthorize ${JSON.stringify({ channels })}`);
    return { success: true };
  }

  statusUrl(code: string) {
    const backend = (process.env.NEXT_PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
    return `${backend}/meta-callbacks/deletion-status/${code}`;
  }

  /** The state of the request a code names, or null for a code that was not issued here. */
  async status(code: string): Promise<DeletionState | null> {
    const request = readDeletionCode(code);
    if (!request) {
      return null;
    }

    if (request.kind === 'person') {
      // pending while any channel that request queued still holds its data; a purged channel is gone,
      // or is a hashed shell with no name
      const open = await this._prisma.integration.count({
        where: {
          rootInternalId: { in: rootIds(request.ref) },
          providerIdentifier: { in: META_PROVIDERS },
          deletedAt: { not: null },
          name: { not: '' },
        },
      });
      return open ? 'pending' : 'done';
    }

    const org = await this._prisma.organization.findFirst({
      where: { id: request.ref },
      select: { id: true },
    });
    if (!org) {
      return null;
    }
    return (await this._retention.workspacePurged(request.ref)) ? 'done' : 'pending';
  }
}
