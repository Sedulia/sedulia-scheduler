import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const WORKSPACE = {
  id: true,
  name: true,
  externalRef: true,
  apiKey: true,
  deletedAt: true,
} as const;

// The only database access the provisioning route has: read an organization by its external ref, and create one.
// It never updates, deletes or lists, and it never touches a user, a membership or a subscription.
@Injectable()
export class ProvisioningRepository {
  constructor(private _organization: PrismaRepository<'organization'>) {}

  findByExternalRef(externalRef: string) {
    return this._organization.model.organization.findUnique({
      where: { externalRef },
      select: WORKSPACE,
    });
  }

  create(externalRef: string, name: string, apiKey: string) {
    return this._organization.model.organization.create({
      data: { name, externalRef, apiKey },
      select: WORKSPACE,
    });
  }
}
