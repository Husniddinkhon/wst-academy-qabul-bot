import type { JsonChannelPostStore } from './channelPosts.js';
import { publishClaimedChannelPost, type ChannelMediaPolicy, type ChannelSender, type PublishResult } from './channelPublisher.js';
import { alertActionableChannelFailures, type JsonOperationalAlertStore } from './operationalAlerts.js';

export const CHANNEL_TIME_ZONE = 'Asia/Tashkent';
export const SCHEDULER_PUBLISHER_ID = 0;

export interface SchedulerRunResult { recovered: number; claimed: number; published: number; failed: number; uncertain: number; retryWait: number }
export interface SchedulerAlertOptions { store: JsonOperationalAlertStore; adminIds: number[] }

export async function runChannelSchedulerOnce(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, now = new Date(), staleClaimMs = 10 * 60_000, mediaPolicy?: ChannelMediaPolicy): Promise<SchedulerRunResult> {
  const [recovered] = await Promise.all([store.recoverExpiredClaims(now), store.closeExpiredReconciliationWindows(now)]);
  const result = { recovered: recovered.length, claimed: 0, published: 0, failed: 0, uncertain: recovered.filter((post) => post.status === 'Uncertain').length, retryWait: recovered.filter((post) => post.status === 'RetryWait').length };
  for (let i = 0; i < 20; i += 1) {
    const claim = await store.claimNextDue(now, SCHEDULER_PUBLISHER_ID, { workerId: `channel-scheduler:${process.pid}`, leaseMs: staleClaimMs });
    if (!claim.ok) break;
    result.claimed += 1;
    const published: PublishResult = await publishClaimedChannelPost(store, sender, channelChatId, claim.post, claim.attemptId, now, mediaPolicy, claim.claimToken, { claimLeaseMs: staleClaimMs });
    if (published.ok) result.published += 1;
    else if (published.reason === 'outcome_uncertain') result.uncertain += 1;
    else if (published.reason === 'retry_wait') result.retryWait += 1;
    else result.failed += 1;
  }
  return result;
}

export function startChannelScheduler(store: JsonChannelPostStore, sender: ChannelSender, channelChatId: string, pollMs: number, staleClaimMs: number, mediaPolicy?: ChannelMediaPolicy, alerts?: SchedulerAlertOptions): NodeJS.Timeout {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runChannelSchedulerOnce(store, sender, channelChatId, new Date(), staleClaimMs, mediaPolicy);
      if (result.recovered || result.claimed || result.failed) console.info(JSON.stringify({ event: 'channel_scheduler_run', ...result }));
    } catch (error) {
      console.error('Channel scheduler failed:', error instanceof Error ? error.message : String(error));
    } finally {
      if (alerts) {
        try {
          const alertResult = await alertActionableChannelFailures(store, sender, alerts.adminIds, alerts.store);
          if (alertResult.attempted > 0) console.info(JSON.stringify({ event: 'channel_failure_alert', attempted: alertResult.attempted, sent: alertResult.sent, failed: alertResult.failed }));
        } catch { console.error('Channel failure alert reconciliation failed.'); }
      }
      running = false;
    }
  };
  void run();
  return setInterval(run, pollMs);
}

export function parseTashkentSchedule(value: string): string | undefined {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:00+05:00`;
  const date = new Date(local);
  if (!Number.isFinite(date.getTime())) return undefined;
  const roundTrip = formatTashkentSchedule(date);
  return roundTrip === `${year}-${month}-${day} ${hour}:${minute}` ? date.toISOString() : undefined;
}

export function formatTashkentSchedule(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: CHANNEL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
