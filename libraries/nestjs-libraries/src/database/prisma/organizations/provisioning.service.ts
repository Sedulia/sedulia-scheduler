import { ConflictException, Injectable } from '@nestjs/common';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { ProvisioningRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/provisioning.repository';

export interface Workspace {
  id: string;
  name: string;
  externalRef: string;
  apiKey: string;
  created: boolean;
}

type Row = {
  id: string;
  name: string;
  externalRef: string | null;
  apiKey: string | null;
  deletedAt: Date | null;
};

// Idempotent on externalRef: one ref is one organization and one API key for good. A repeat returns what is stored,
// never renames and never rotates. A unique violation (two first calls racing) re-reads and returns the winner.
@Injectable()
export class ProvisioningService {
  constructor(private _repository: ProvisioningRepository) {}

  async ensureWorkspace(externalRef: string, name: string): Promise<Workspace> {
    const existing = await this._repository.findByExternalRef(externalRef);
    if (existing) {
      return this.answer(existing, false);
    }

    // The same shape a normal registration gives an organization's key (AuthService.fixedEncryption of 20+ secure characters).
    const apiKey = AuthService.fixedEncryption(makeSecureId(32));
    try {
      return this.answer(await this._repository.create(externalRef, name, apiKey), true);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') {
        throw err;
      }
      const winner = await this._repository.findByExternalRef(externalRef);
      if (!winner) {
        throw err;
      }
      return this.answer(winner, false);
    }
  }

  private answer(row: Row, created: boolean): Workspace {
    if (row.deletedAt) {
      // A closed workspace is not handed out again as if it were live.
      throw new ConflictException('workspace_closed');
    }
    return {
      id: row.id,
      name: row.name,
      externalRef: row.externalRef as string,
      apiKey: row.apiKey as string,
      created,
    };
  }
}
