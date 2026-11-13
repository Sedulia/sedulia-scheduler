import { BadRequestException, Body, Controller, Param, Put, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProvisioningService } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.service';
import { ProvisioningTokenGuard } from '@gitroom/backend/public-api/provisioning/provisioning.token.guard';
import { ProvisioningRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.repository';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { ProvisioningOwnerRepository } from '@gitroom/backend/public-api/provisioning/owner.repository';
import { ProvisioningOwnerService } from '@gitroom/backend/public-api/provisioning/owner.service';

const REF = /^[0-9a-f]{32}$/;
const NAME = /^[a-z0-9][a-z0-9_]{1,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// PUT /public/v1/provisioning/workspaces/:externalRef   body {"name"}
// Acts above any organization, so it is NOT in authenticatedController (public.api.module.ts) and has its own token.
// The workspace route can only create a workspace or read the one a ref already made.
// The owner route (PUT .../:externalRef/owner) makes the workspace's first user with no password, never a super admin, and
// Postiz mails the set-password link itself: no link, password or token is ever in a response or a log. Both routes share
// the one token guard. Neither can delete anything, touch another organization or make a super admin.
@ApiExcludeController()
@Controller('/public/v1/provisioning/workspaces')
@UseGuards(ProvisioningTokenGuard)
export class ProvisioningController {
  private _owners: ProvisioningOwnerService;

  // The owner service is built here, from providers PublicApiModule already has, so the module file is untouched.
  constructor(
    private _provisioningService: ProvisioningService,
    workspaces: ProvisioningRepository,
    prisma: PrismaRepository<'user' | 'userOrganization'>,
    email: EmailService
  ) {
    this._owners = new ProvisioningOwnerService(workspaces, new ProvisioningOwnerRepository(prisma), email);
  }

  @Put('/:externalRef')
  async ensureWorkspace(
    @Param('externalRef') externalRef: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response
  ) {
    if (typeof externalRef !== 'string' || !REF.test(externalRef)) {
      throw new BadRequestException('externalRef must be 32 lower case hex characters');
    }
    const name = body && typeof body === 'object' && !Array.isArray(body) ? (body as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new BadRequestException('name must match ^[a-z0-9][a-z0-9_]{1,40}$');
    }

    const workspace = await this._provisioningService.ensureWorkspace(externalRef, name);
    res.status(workspace.created ? 201 : 200);
    return workspace;
  }

  @Put('/:externalRef/owner')
  async ensureOwner(
    @Param('externalRef') externalRef: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response
  ) {
    if (typeof externalRef !== 'string' || !REF.test(externalRef)) {
      throw new BadRequestException('externalRef must be 32 lower case hex characters');
    }
    // Only the address is read: nothing else in the body can reach the user that is made.
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as { email?: unknown }).email : undefined;
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL.test(email)) {
      throw new BadRequestException('email must be an email address');
    }

    const owner = await this._owners.ensureOwner(externalRef, email);
    res.status(owner.created ? 201 : 200);
    return owner;
  }
}
