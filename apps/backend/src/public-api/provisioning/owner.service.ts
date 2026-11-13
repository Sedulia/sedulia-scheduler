import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import dayjs from 'dayjs';
import { signResetToken } from '@gitroom/backend/services/auth/reset.token';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { ProvisioningRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.repository';
import { ProvisioningOwnerRepository } from '@gitroom/backend/public-api/provisioning/owner.repository';

export interface OwnerResult {
  externalRef: string;
  email: string;
  created: boolean;
  emailed: boolean;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

// First login: the workspace's owner is a user with no password, made once, and Postiz itself
// mails the set-password link over the stack's own SMTP. The link lives only inside that mail: it is never returned, never
// logged, and never reaches the caller. The user is never a super admin and has one membership, this workspace.
//
// Idempotent on the reference and the address: a repeat is a 200 that makes and sends nothing; a different address for a
// workspace that already has an owner is a 409; two calls at once make one user, one membership and one mail.
export class ProvisioningOwnerService {
  constructor(
    private _workspaces: ProvisioningRepository,
    private _owners: ProvisioningOwnerRepository,
    private _email: EmailService
  ) {}

  async ensureOwner(externalRef: string, email: string): Promise<OwnerResult> {
    const workspace = await this._workspaces.findByExternalRef(externalRef);
    if (!workspace) {
      throw new NotFoundException('workspace_not_found');
    }
    if (workspace.deletedAt) {
      throw new ConflictException('workspace_closed');
    }

    const existingOwner = await this._owners.findOwnerOf(workspace.id);
    if (existingOwner) {
      return this.existing(externalRef, email, existingOwner.user.email);
    }

    const known = await this._owners.findUserByEmail(email);
    if (known) {
      return this.join(externalRef, workspace.id, email, known.id);
    }

    // No user for this address yet: the set-password mail is the only way in, so refuse before writing if it cannot go.
    if (!this._email.hasProvider() || !process.env.EMAIL_FROM_ADDRESS || !process.env.EMAIL_FROM_NAME) {
      throw new ServiceUnavailableException('email_not_configured');
    }

    let userId: string;
    try {
      userId = (await this._owners.createOwner(workspace.id, email)).id;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // Another call made the user (or the owner) a moment ago: answer from what it stored.
      const owner = await this._owners.findOwnerOf(workspace.id);
      if (owner) {
        return this.existing(externalRef, email, owner.user.email);
      }
      const winner = await this._owners.findUserByEmail(email);
      if (!winner) {
        throw err;
      }
      return this.join(externalRef, workspace.id, email, winner.id);
    }

    await this.sendSetPassword(email, userId);
    return { externalRef, email, created: true, emailed: true };
  }

  private existing(externalRef: string, email: string, ownerEmail: string): OwnerResult {
    if (ownerEmail.toLowerCase() !== email) {
      // The message never repeats the stored address.
      throw new ConflictException('owner_exists');
    }
    return { externalRef, email, created: false, emailed: false };
  }

  // The address already has a user (it owns or belongs to another workspace): add this workspace, change nothing else.
  private async join(externalRef: string, organizationId: string, email: string, userId: string): Promise<OwnerResult> {
    try {
      await this._owners.addOwnerMembership(userId, organizationId);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      return { externalRef, email, created: false, emailed: false };
    }
    return { externalRef, email, created: true, emailed: false };
  }

  private async sendSetPassword(email: string, userId: string) {
    // A reset token (never a session: AuthMiddleware refuses it) good for seven days and for one use: it is tied to the
    // password the owner has now, which is none.
    const reset = signResetToken({ id: userId, password: '' }, dayjs().add(7, 'day').format('YYYY-MM-DD HH:mm:ss'));
    await this._email.sendEmailSync(
      email,
      'Set your Sedulia Social password',
      `Your Sedulia Social workspace is ready. <br />Click <a href="${process.env.FRONTEND_URL}/auth/forgot/${reset}">here</a> to choose your password.<br />The link works for 7 days. After that, use Forgot Password on the sign in page.`
    );
  }
}
