import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

// Starts the daily retention purge. The workflow id is fixed and an existing run is kept, so any number
// of orchestrators can start at once and exactly one schedule exists. Not tied to RUN_CRON: a retention
// promise must not depend on a flag that may be unset.
export const RETENTION_PURGE_WORKFLOW_ID = 'retention-purge-workflow';
export const RETENTION_PURGE_CRON = '17 3 * * *';

@Injectable()
export class RetentionPurgeStarter implements OnModuleInit {
  private readonly _logger = new Logger(RetentionPurgeStarter.name);

  constructor(private _temporalService: TemporalService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('retentionPurgeWorkflow', {
          workflowId: RETENTION_PURGE_WORKFLOW_ID,
          taskQueue: 'main',
          cronSchedule: RETENTION_PURGE_CRON,
          workflowIdConflictPolicy: 'USE_EXISTING',
        });
    } catch (err) {
      this._logger.error(
        `retention purge schedule not started: ${(err as any)?.name || 'Error'}`
      );
    }
  }
}
