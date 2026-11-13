import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';

// Retention (the wording is in the Terms and Privacy policy):
//   - a network token is removed at disconnect, at channel delete and at workspace closure
//     (integration.repository.ts empties it at those three acts; this service sweeps any that survive);
//   - content is kept while a workspace is open and purged within 30 days after closure;
//   - a deleted channel's rows are purged within 30 days after the deletion.
// The purge runs daily from the orchestrator. It logs counts, never content.

export const RETENTION_DAYS = 30;
// The cutoff rule: a closure or a channel deletion is purged at a 29 day cutoff.
// The purge runs once a day, so the run that finds it is at most a day late, which is still inside the
// 30 days the Terms promise ("within 30 days"; the Terms wording is unchanged).
export const PURGE_AFTER_DAYS = 29;
// A person's deletion request is queued so it is due this many days after the request, a day of margin
// before the 29 day cutoff.
export const REQUEST_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 500;
// A deletion on a big workspace can run long; Prisma's default of 5 seconds would roll it back every day.
const TX_OPTIONS = { maxWait: 60_000, timeout: 10 * 60_000 };

// Every schema model that carries an organizationId or orgId is either purged with a closed workspace or kept,
// and a test reads the schema to prove no model is left out of both lists.
export const PURGED_ORG_MODELS = [
  'Post',
  'Comments',
  'Errors',
  'Media',
  'Plugs',
  'Webhooks',
  'Tags',
  'Customer',
  'Signatures',
  'Sets',
  'AutoPost',
  'Notifications',
  'ThirdParty',
  'GitHub',
  'Clipping',
  'OAuthAuthorization',
] as const;
// Kept on purpose (the kept history rule), each for a reason:
//   Subscription, Credits, UsedCodes: billing records, kept as the law requires;
//   UserOrganization: membership, which says who the workspace belonged to (the login records are cleared);
//   OAuthApp: the app definition, its secret is cleared;
//   Integration: a closed workspace's channel stays as a hashed shell (the md5 of the network account id
//     and nothing else) because checkPreviousConnections reads it to stop a channel from taking a second
//     free trial; a deleted channel of an open workspace is purged whole.
export const KEPT_ORG_MODELS = [
  'Subscription',
  'Credits',
  'UsedCodes',
  'UserOrganization',
  'OAuthApp',
  'Integration',
] as const;

// What a closed workspace's channel keeps is only its hashed identity; everything else is cleared.
const SHELL: Record<string, string | null> = {
  name: '',
  customName: null,
  profile: null,
  picture: null,
  customInstanceDetails: null,
  additionalSettings: '[]',
  customerId: null,
  token: '',
  refreshToken: '',
  tokenExpiration: null,
};

export interface PurgeCounts {
  workspaces: number;
  channels: number;
  posts: number;
  comments: number;
  errors: number;
  media: number;
  files: number;
  users: number;
  other: number;
  failures: number;
}

const emptyCounts = (): PurgeCounts => ({
  workspaces: 0,
  channels: 0,
  posts: 0,
  comments: 0,
  errors: 0,
  media: 0,
  files: 0,
  users: 0,
  other: 0,
  failures: 0,
});

const chunks = <T>(list: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
};

@Injectable()
export class RetentionService {
  private readonly _logger = new Logger(RetentionService.name);
  private storage = UploadFactory.createStorage();

  constructor(private _prisma: PrismaService) {}

  // The moment before which a closure or a channel deletion is due for the purge.
  private cutoff(now: Date) {
    return new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS);
  }

  // A file in our own storage (local uploads or our bucket); anything else is never touched.
  private ours(url?: string | null) {
    const own = [
      process.env.FRONTEND_URL && `${process.env.FRONTEND_URL}/uploads`,
      process.env.CLOUDFLARE_BUCKET_URL,
    ].filter(Boolean) as string[];
    return !!url && own.some((prefix) => url.startsWith(prefix));
  }

  /**
   * One person's data request (the Meta deletion callback): empties the tokens of the named
   * channels at once, and queues their rows, so the daily purge removes them, their posts and their
   * dependents REQUEST_DAYS later, inside the 30 days. A channel deleted earlier than that keeps its
   * earlier date; one deleted later is moved back to it. A channel is named by its id or by the network
   * account it was connected from (rootInternalId). With nothing named, nothing happens.
   */
  async removeTokensAndQueue(
    target: { integrationIds?: string[]; rootInternalIds?: string[] },
    now = new Date()
  ): Promise<{ channels: number }> {
    const integrationIds = target.integrationIds || [];
    const rootInternalIds = target.rootInternalIds || [];
    if (!integrationIds.length && !rootInternalIds.length) {
      return { channels: 0 };
    }

    const where = {
      OR: [
        ...(integrationIds.length ? [{ id: { in: integrationIds } }] : []),
        ...(rootInternalIds.length
          ? [{ rootInternalId: { in: rootInternalIds } }]
          : []),
      ],
    };

    const found = await this._prisma.integration.findMany({
      where,
      select: { id: true },
    });
    const emptied = await this._prisma.integration.updateMany({
      where,
      data: { token: '', refreshToken: '', refreshNeeded: true },
    });
    // queue: the row is dated so it is due REQUEST_DAYS after the request. A channel not yet deleted
    // gets the date; an earlier deletion date stands; a later one (a deletion in the last day or so) is
    // moved back to it, so the request is never due after the promised 30 days (the late request rule).
    const queued = new Date(
      now.getTime() - (PURGE_AFTER_DAYS - REQUEST_DAYS) * DAY_MS
    );
    await this._prisma.integration.updateMany({
      where: { AND: [where, { deletedAt: null }] },
      data: { deletedAt: queued },
    });
    await this._prisma.integration.updateMany({
      where: { AND: [where, { deletedAt: { gt: queued } }] },
      data: { deletedAt: queued },
    });

    this._logger.log(
      `retention tokens removed ${JSON.stringify({
        channels: emptied.count,
        matched: found.length,
      })}`
    );
    return { channels: emptied.count };
  }

  /**
   * Whether a closed workspace has been purged: the cutoff has passed, no purged model holds a row of it,
   * every channel is down to its hashed shell, its API key is gone and no member who belongs to nothing
   * else still carries a login ip or agent. The status page says "done" only on this, never on time alone.
   */
  async workspacePurged(orgId: string, now = new Date()): Promise<boolean> {
    const org = await this._prisma.organization.findFirst({
      where: { id: orgId },
      select: { deletedAt: true, apiKey: true },
    });
    if (!org || !org.deletedAt || org.deletedAt.getTime() > this.cutoff(now).getTime() || org.apiKey) {
      return false;
    }

    for (const model of PURGED_ORG_MODELS) {
      const delegate = model.charAt(0).toLowerCase() + model.slice(1);
      const column = model === 'Tags' || model === 'Customer' ? 'orgId' : 'organizationId';
      if (await (this._prisma as any)[delegate].count({ where: { [column]: orgId } })) {
        return false;
      }
    }
    if (await this._prisma.integration.count({ where: { organizationId: orgId, name: { not: '' } } })) {
      return false;
    }

    // the members whose login records the purge releases: all of their workspaces are due
    const members = await this._prisma.userOrganization.findMany({
      where: { organizationId: orgId },
      select: { userId: true },
    });
    const userIds: string[] = Array.from(new Set(members.map((m: any) => m.userId)));
    if (userIds.length) {
      const memberships = await this._prisma.userOrganization.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, organizationId: true },
      });
      const orgs = await this._prisma.organization.findMany({
        where: { id: { in: Array.from(new Set(memberships.map((m: any) => m.organizationId))) } },
        select: { id: true, deletedAt: true },
      });
      const cutoff = this.cutoff(now);
      const due = new Set(
        orgs.filter((o: any) => o.deletedAt && o.deletedAt.getTime() <= cutoff.getTime()).map((o: any) => o.id)
      );
      const stillIn = new Set(
        memberships.filter((m: any) => !due.has(m.organizationId)).map((m: any) => m.userId)
      );
      const released = userIds.filter((id) => !stillIn.has(id));
      if (
        released.length &&
        (await this._prisma.user.count({
          where: { id: { in: released }, OR: [{ ip: { not: null } }, { agent: { not: null } }] },
        }))
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * The daily purge. Safe to run any number of times: a second run finds nothing to do.
   */
  async purgeExpired(now = new Date()): Promise<PurgeCounts> {
    const counts = emptyCounts();
    const cutoff = this.cutoff(now);

    await this.sweepTokens();

    const dueOrgs = await this._prisma.organization.findMany({
      where: { deletedAt: { lte: cutoff } },
      select: { id: true },
    });
    for (const { id } of dueOrgs) {
      try {
        await this.purgeWorkspace(id, cutoff, counts);
      } catch (err) {
        counts.failures++;
        // the class and the code only: an error message can carry a row's values
        this._logger.error(
          `retention workspace purge failed ${JSON.stringify({
            error: (err as any)?.code || (err as any)?.name || 'Error',
          })}`
        );
      }
    }

    const dueChannels = await this._prisma.integration.findMany({
      where: { deletedAt: { lte: cutoff } },
      select: { id: true },
    });
    for (const group of chunks(dueChannels.map((c: any) => c.id))) {
      try {
        await this.purgeChannels(group, cutoff, counts);
      } catch (err) {
        counts.failures++;
        this._logger.error(
          `retention channel purge failed ${JSON.stringify({
            error: (err as any)?.code || (err as any)?.name || 'Error',
          })}`
        );
      }
    }

    this._logger.log(`retention purge ${JSON.stringify(counts)}`);
    return counts;
  }

  // A token never outlives a deletion or a closure: this catches any path that did not empty it.
  private async sweepTokens() {
    const hasToken = [{ token: { not: '' } }, { refreshToken: { not: '' } }];
    await this._prisma.integration.updateMany({
      where: { deletedAt: { not: null }, OR: hasToken },
      data: { token: '', refreshToken: '' },
    });
    await this._prisma.integration.updateMany({
      where: { organization: { deletedAt: { not: null } }, OR: hasToken },
      data: { token: '', refreshToken: '' },
    });
  }

  private async removeFile(path: string): Promise<'removed' | 'gone' | 'foreign'> {
    try {
      await this.storage.removeFile(path);
      return 'removed';
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return 'gone';
      }
      // not a file in our own storage: never touched, never blocks the purge
      if (err?.message === 'Unsafe file path') {
        return 'foreign';
      }
      throw err;
    }
  }

  // Files that belong to a workspace: media and their thumbnails, our copies of channel pictures, and clips.
  private async workspaceFiles(orgId: string) {
    const ours = (url?: string | null) => this.ours(url);

    const media = await this._prisma.media.findMany({
      where: { organizationId: orgId },
      select: { id: true, path: true, thumbnail: true },
    });
    const pictures = await this._prisma.integration.findMany({
      where: { organizationId: orgId },
      select: { picture: true },
    });
    const clippings = await this._prisma.clipping.findMany({
      where: { organizationId: orgId },
      select: { id: true, thumbnail: true },
    });
    const clips: any[] = [];
    for (const group of chunks<string>(clippings.map((c: any) => c.id))) {
      clips.push(
        ...(await this._prisma.clippingClip.findMany({
          where: { clippingId: { in: group } },
          select: { path: true, thumbnail: true },
        }))
      );
    }

    const paths = [
      ...(media as any[]).flatMap((m) => [m.path, m.thumbnail]),
      ...(pictures as any[]).map((i) => i.picture).filter(ours),
      ...(clippings as any[]).map((c) => c.thumbnail),
      ...clips.flatMap((c) => [c.path, c.thumbnail]),
    ].filter(Boolean) as string[];
    return {
      mediaIds: (media as any[]).map((m) => m.id) as string[],
      paths: Array.from(new Set(paths)),
    };
  }

  private async purgeWorkspace(
    orgId: string,
    cutoff: Date,
    counts: PurgeCounts
  ) {
    // the workspace may have been reopened since the list was read
    if (
      !(await this._prisma.organization.findFirst({
        where: { id: orgId, deletedAt: { lte: cutoff } },
        select: { id: true },
      }))
    ) {
      return;
    }

    // Files first. If one cannot be removed, the whole workspace waits for tomorrow, so no row is
    // deleted while its file is still on disk.
    const { mediaIds, paths } = await this.workspaceFiles(orgId);
    let files = 0;
    for (const path of paths) {
      if ((await this.removeFile(path)) === 'removed') {
        files++;
      }
    }

    await this._prisma.$transaction(async (tx: any) => {
      if (
        !(await tx.organization.findFirst({
          where: { id: orgId, deletedAt: { lte: cutoff } },
          select: { id: true },
        }))
      ) {
        return;
      }
      const byOrg = { organizationId: orgId };
      let other = 0;

      const posts = await tx.post.findMany({
        where: byOrg,
        select: { id: true },
      });
      for (const group of chunks<string>(posts.map((p: any) => p.id))) {
        await tx.tagsPosts.deleteMany({ where: { postId: { in: group } } });
        await tx.payoutProblems.deleteMany({ where: { postId: { in: group } } });
      }
      const errors = await tx.errors.deleteMany({ where: byOrg });
      const comments = await tx.comments.deleteMany({ where: byOrg });
      const deletedPosts = await tx.post.deleteMany({ where: byOrg });

      // webhooks and their links to channels
      const webhooks = await tx.webhooks.findMany({
        where: byOrg,
        select: { id: true },
      });
      for (const group of chunks<string>(webhooks.map((w: any) => w.id))) {
        await tx.integrationsWebhooks.deleteMany({ where: { webhookId: { in: group } } });
      }
      other += (await tx.webhooks.deleteMany({ where: byOrg })).count;

      // the channels stay as hashed shells for the trial check (the kept history rule); their dependents go
      const integrations = await tx.integration.findMany({
        where: byOrg,
        select: { id: true },
      });
      let shelled = 0;
      for (const group of chunks<string>(integrations.map((i: any) => i.id))) {
        await this.deleteChannelDependents(tx, group);
        shelled += await this.shellChannels(tx, group);
      }

      // clips
      const clippings = await tx.clipping.findMany({
        where: byOrg,
        select: { id: true },
      });
      for (const group of chunks<string>(clippings.map((c: any) => c.id))) {
        other += (await tx.clippingClip.deleteMany({ where: { clippingId: { in: group } } })).count;
      }
      other += (await tx.clipping.deleteMany({ where: byOrg })).count;

      // everything else the workspace owns: content, saved settings and credentials
      other += (await tx.oAuthAuthorization.deleteMany({ where: byOrg })).count;
      await tx.oAuthApp.updateMany({
        where: byOrg,
        data: { clientSecret: null },
      });
      other += (await tx.customer.deleteMany({ where: { orgId } })).count;
      other += (await tx.tags.deleteMany({ where: { orgId } })).count;
      for (const model of ['signatures', 'sets', 'autoPost', 'notifications', 'thirdParty', 'gitHub']) {
        other += (await tx[model].deleteMany({ where: byOrg })).count;
      }

      for (const group of chunks<string>(mediaIds)) {
        // a member's profile picture may be one of the workspace's media rows
        await tx.user.updateMany({
          where: { pictureId: { in: group } },
          data: { pictureId: null },
        });
        await tx.oAuthApp.updateMany({
          where: { pictureId: { in: group } },
          data: { pictureId: null },
        });
      }
      const deletedMedia = await tx.media.deleteMany({ where: byOrg });

      const users = await this.clearLoginRecords(tx, orgId, cutoff);

      // the workspace's own API key goes with its content
      await tx.organization.update({
        where: { id: orgId },
        data: { apiKey: null },
      });

      counts.workspaces++;
      counts.channels += shelled;
      counts.posts += deletedPosts.count;
      counts.comments += comments.count;
      counts.errors += errors.count;
      counts.media += deletedMedia.count;
      counts.files += files;
      counts.users += users;
      counts.other += other;
    }, TX_OPTIONS);
  }

  // The login ip and agent of the workspace's members, unless the member still belongs to a workspace
  // that is open or closed less than 30 days ago.
  private async clearLoginRecords(tx: any, orgId: string, cutoff: Date) {
    const members = await tx.userOrganization.findMany({
      where: { organizationId: orgId },
      select: { userId: true },
    });
    const userIds: string[] = Array.from(new Set(members.map((m: any) => m.userId)));
    if (!userIds.length) {
      return 0;
    }

    const memberships = await tx.userOrganization.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, organizationId: true },
    });
    const orgs = await tx.organization.findMany({
      where: {
        id: { in: Array.from(new Set(memberships.map((m: any) => m.organizationId))) },
      },
      select: { id: true, deletedAt: true },
    });
    const due = new Set(
      orgs
        .filter((o: any) => o.deletedAt && o.deletedAt.getTime() <= cutoff.getTime())
        .map((o: any) => o.id)
    );
    const stillIn = new Set(
      memberships
        .filter((m: any) => !due.has(m.organizationId))
        .map((m: any) => m.userId)
    );
    const release = userIds.filter((id) => !stillIn.has(id));

    let cleared = 0;
    for (const group of chunks<string>(release)) {
      const done = await tx.user.updateMany({
        where: { id: { in: group }, OR: [{ ip: { not: null } }, { agent: { not: null } }] },
        data: { ip: null, agent: null },
      });
      cleared += done.count;
    }
    return cleared;
  }

  private async deleteChannelDependents(tx: any, integrationIds: string[]) {
    await tx.plugs.deleteMany({ where: { integrationId: { in: integrationIds } } });
    await tx.exisingPlugData.deleteMany({ where: { integrationId: { in: integrationIds } } });
    await tx.integrationsWebhooks.deleteMany({ where: { integrationId: { in: integrationIds } } });
  }

  // Clears a closed workspace's channels down to their hashed identity. Returns how many had anything
  // left to clear, so a second run counts nothing.
  private async shellChannels(tx: any, integrationIds: string[]) {
    const rows = await tx.integration.findMany({
      where: { id: { in: integrationIds } },
      select: { id: true, ...Object.fromEntries(Object.keys(SHELL).map((k) => [k, true])) },
    });
    const todo: string[] = rows
      .filter((r: any) =>
        Object.entries(SHELL).some(([k, v]) => (r[k] ?? null) !== v)
      )
      .map((r: any) => r.id);
    if (todo.length) {
      await tx.integration.updateMany({
        where: { id: { in: todo } },
        data: SHELL,
      });
    }
    return todo.length;
  }

  // Deleted channels past the cutoff, in a workspace that may well be open: their own posts, dependents
  // and picture copy go with them, nothing else of the workspace does. A channel of a closed workspace
  // stays as a hashed shell (the kept history rule).
  private async purgeChannels(
    integrationIds: string[],
    cutoff: Date,
    counts: PurgeCounts
  ) {
    // Files first (the picture copy rule), as for a workspace: if a picture copy cannot be removed, the channels wait
    // for tomorrow. A copy another channel still points at stays.
    const withPicture = await this._prisma.integration.findMany({
      where: { id: { in: integrationIds }, deletedAt: { lte: cutoff } },
      select: { id: true, picture: true },
    });
    const dueIds = (withPicture as any[]).map((i) => i.id);
    let files = 0;
    for (const { picture } of withPicture as any[]) {
      if (!this.ours(picture)) {
        continue;
      }
      const stillUsed = await this._prisma.integration.findFirst({
        where: { picture, NOT: { id: { in: dueIds } } },
        select: { id: true },
      });
      if (!stillUsed && (await this.removeFile(picture)) === 'removed') {
        files++;
      }
    }

    await this._prisma.$transaction(async (tx: any) => {
      // read again inside the transaction: a channel that was reconnected meanwhile is no longer deleted
      const due = await tx.integration.findMany({
        where: { id: { in: integrationIds }, deletedAt: { lte: cutoff } },
        select: { id: true, organizationId: true },
      });
      const ids: string[] = due.map((i: any) => i.id);
      if (!ids.length) {
        return;
      }
      const closedOrgs = new Set(
        (
          await tx.organization.findMany({
            where: {
              id: { in: Array.from(new Set(due.map((i: any) => i.organizationId))) },
              deletedAt: { not: null },
            },
            select: { id: true },
          })
        ).map((o: any) => o.id)
      );
      const shellIds = due.filter((i: any) => closedOrgs.has(i.organizationId)).map((i: any) => i.id);
      const deleteIds = ids.filter((id) => !shellIds.includes(id));

      const posts = await tx.post.findMany({
        where: { integrationId: { in: ids } },
        select: { id: true },
      });
      const postIds: string[] = posts.map((p: any) => p.id);
      for (const group of chunks<string>(postIds)) {
        await tx.tagsPosts.deleteMany({ where: { postId: { in: group } } });
        await tx.payoutProblems.deleteMany({ where: { postId: { in: group } } });
        counts.errors += (await tx.errors.deleteMany({ where: { postId: { in: group } } })).count;
        counts.comments += (await tx.comments.deleteMany({ where: { postId: { in: group } } })).count;
      }
      counts.posts += (await tx.post.deleteMany({ where: { integrationId: { in: ids } } })).count;
      await this.deleteChannelDependents(tx, ids);
      counts.channels += (
        await tx.integration.deleteMany({
          where: { id: { in: deleteIds }, deletedAt: { lte: cutoff } },
        })
      ).count;
      if (shellIds.length) {
        counts.channels += await this.shellChannels(tx, shellIds);
      }
      counts.files += files;
    }, TX_OPTIONS);
  }
}
