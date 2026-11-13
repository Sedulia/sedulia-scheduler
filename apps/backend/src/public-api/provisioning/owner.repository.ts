import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// The only database access the owner route has beyond ProvisioningRepository: look up a user by address, look up who owns
// an organization, create the owner user with its one membership, and add a membership for a user that already exists.
// It never updates or deletes, never lists, and it never writes a password, a super admin flag or any other organization.
export class ProvisioningOwnerRepository {
  constructor(private _prisma: PrismaRepository<'user' | 'userOrganization'>) {}

  findUserByEmail(email: string) {
    return this._prisma.model.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, providerName: 'LOCAL', deletedAt: null },
      select: { id: true, email: true },
    });
  }

  findOwnerOf(organizationId: string) {
    return this._prisma.model.userOrganization.findFirst({
      where: { organizationId, role: 'SUPERADMIN' },
      select: { id: true, user: { select: { id: true, email: true } } },
    });
  }

  // One write: the user and its membership of this one organization. No password, never a super admin.
  createOwner(organizationId: string, email: string) {
    return this._prisma.model.user.create({
      data: {
        email,
        password: '',
        providerName: 'LOCAL',
        providerId: '',
        isSuperAdmin: false,
        activated: true,
        timezone: 0,
        organizations: { create: { organizationId, role: 'SUPERADMIN' } },
      },
      select: { id: true, email: true },
    });
  }

  addOwnerMembership(userId: string, organizationId: string) {
    return this._prisma.model.userOrganization.create({
      data: { userId, organizationId, role: 'SUPERADMIN' },
      select: { id: true },
    });
  }
}
