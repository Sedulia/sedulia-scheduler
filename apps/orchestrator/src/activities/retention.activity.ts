import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { RetentionService } from '@gitroom/nestjs-libraries/database/prisma/retention/retention.service';

@Injectable()
@Activity()
export class RetentionActivity {
  constructor(private _retentionService: RetentionService) {}

  // The daily purge: counts only, never content.
  @ActivityMethod()
  async purgeExpired() {
    return this._retentionService.purgeExpired();
  }
}
