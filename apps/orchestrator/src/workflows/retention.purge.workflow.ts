import { proxyActivities } from '@temporalio/workflow';
import { RetentionActivity } from '@gitroom/orchestrator/activities/retention.activity';

const { purgeExpired } = proxyActivities<RetentionActivity>({
  startToCloseTimeout: '30 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '10 minutes',
  },
});

// One run of the retention purge. The orchestrator starts it with a daily cron schedule
// (retention.purge.starter.ts), so each run is a fresh, short workflow.
export async function retentionPurgeWorkflow() {
  return await purgeExpired();
}
