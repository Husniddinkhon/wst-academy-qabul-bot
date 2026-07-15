import type { ChannelPost, ChannelPostStatus, JsonChannelPostStore } from './channelPosts.js';
import { REPORT_TIME_ZONE } from './dailyReport.js';
import { buildSalesReport, type SalesReportDependencies, type SalesReportRange, type SalesReportSnapshot } from './salesReporting.js';
import type { JsonOperationalAlertStore, OperationalAlertStats } from './operationalAlerts.js';

export interface OperationalBotHealth {
  botReachable: boolean;
  channelReachable: boolean;
  subscriberCount?: number;
}

export interface OperationalContentSnapshot {
  available: boolean;
  counts: Record<ChannelPostStatus | 'due', number>;
  nextScheduledAt?: string;
  nextContentKey?: string;
}

export interface OperationalReportSnapshot {
  generatedAt: string;
  range: SalesReportRange;
  status: 'OK' | 'ATTENTION' | 'DEGRADED';
  bot: OperationalBotHealth;
  content: OperationalContentSnapshot;
  sales?: SalesReportSnapshot;
  alertDelivery?: OperationalAlertStats;
  unavailableSections: string[];
}

export interface OperationalReportDependencies {
  channelPosts: Pick<JsonChannelPostStore, 'all'>;
  sales: SalesReportDependencies;
  botHealth: () => Promise<OperationalBotHealth>;
  alerts?: Pick<JsonOperationalAlertStore, 'stats'>;
}

const EMPTY_CONTENT_COUNTS: OperationalContentSnapshot['counts'] = {
  Draft: 0,
  Scheduled: 0,
  Publishing: 0,
  Published: 0,
  Failed: 0,
  Cancelled: 0,
  due: 0,
};

export async function buildOperationalReport(
  range: SalesReportRange,
  dependencies: OperationalReportDependencies,
  now = new Date(),
): Promise<OperationalReportSnapshot> {
  const [contentResult, salesResult, botResult, alertResult] = await Promise.allSettled([
    dependencies.channelPosts.all(),
    buildSalesReport(range, dependencies.sales, now),
    dependencies.botHealth(),
    dependencies.alerts ? dependencies.alerts.stats(now) : Promise.resolve(undefined),
  ]);

  const unavailableSections: string[] = [];
  const content = contentResult.status === 'fulfilled'
    ? summarizeContent(contentResult.value, now)
    : unavailableContent();
  if (!content.available) unavailableSections.push('content storage');

  const sales = salesResult.status === 'fulfilled' ? salesResult.value : undefined;
  if (!sales) unavailableSections.push('lead/webhook report');

  const bot = botResult.status === 'fulfilled'
    ? botResult.value
    : { botReachable: false, channelReachable: false };
  if (botResult.status === 'rejected') unavailableSections.push('Telegram health probe');
  const alertDelivery = alertResult.status === 'fulfilled' ? alertResult.value : undefined;
  if (alertResult.status === 'rejected') unavailableSections.push('operational alert state');

  const degraded = unavailableSections.length > 0 || !bot.botReachable || !bot.channelReachable;
  const needsAttention = content.counts.Failed > 0
    || content.counts.Publishing > 0
    || content.counts.due > 0
    || (sales?.webhookFailuresQueued ?? 0) > 0
    || (alertDelivery?.recipientsPending ?? 0) > 0
    || sales?.academy.available === false;

  return {
    generatedAt: now.toISOString(),
    range,
    status: degraded ? 'DEGRADED' : needsAttention ? 'ATTENTION' : 'OK',
    bot,
    content,
    sales,
    alertDelivery,
    unavailableSections,
  };
}

export function formatOperationalReport(snapshot: OperationalReportSnapshot): string {
  const content = snapshot.content;
  const sales = snapshot.sales;
  const lines = [
    `🧭 WST Academy operations | ${snapshot.status}`,
    `${snapshot.range.fromKey} — ${snapshot.range.toKey} | ${REPORT_TIME_ZONE}`,
    '',
    'Bot/channel health',
    `Bot API: ${snapshot.bot.botReachable ? 'OK' : 'UNAVAILABLE'}`,
    `Channel API: ${snapshot.bot.channelReachable ? 'OK' : 'UNAVAILABLE'}`,
    `Subscribers: ${snapshot.bot.subscriberCount ?? 'mavjud emas'}`,
    '',
    'Content pipeline',
    content.available
      ? `Draft ${content.counts.Draft} | Scheduled ${content.counts.Scheduled} | Due ${content.counts.due} | Publishing ${content.counts.Publishing}`
      : 'Content storage: UNAVAILABLE',
    content.available
      ? `Published ${content.counts.Published} | Failed/manual review ${content.counts.Failed} | Cancelled ${content.counts.Cancelled}`
      : undefined,
    content.nextScheduledAt
      ? `Next: ${formatTashkentDateTime(content.nextScheduledAt)}${content.nextContentKey ? ` | ${content.nextContentKey}` : ''}`
      : content.available ? 'Next: rejalashtirilmagan' : undefined,
    '',
    'Lead/sales funnel',
    sales ? `New leads: ${sales.leadCount}` : 'Lead report: UNAVAILABLE',
    sales?.eventMetrics.available
      ? `Tracked: lead ${sales.eventMetrics.leadCreationsTracked} | hot ${sales.eventMetrics.hotEscalations} | registration ${sales.eventMetrics.registrations}`
      : sales ? 'Event metrics: mavjud emas' : undefined,
    sales ? `Webhook failures in range: ${sales.webhookFailuresInRange}` : undefined,
    sales ? `Webhook retry/outbox queue now: ${sales.webhookFailuresQueued}` : undefined,
    snapshot.alertDelivery ? `Operational alert recipients: delivered ${snapshot.alertDelivery.recipientsDelivered} | pending ${snapshot.alertDelivery.recipientsPending} | ready ${snapshot.alertDelivery.recipientsReady}` : undefined,
    '',
    'Academy aggregate',
    sales?.academy.available
      ? `Admissions ${sales.academy.admissions} | Enrollments ${sales.academy.enrollmentsCreated} | Verified paid ${sales.academy.verifiedPaidConversions} | Active fully-paid ${sales.academy.activeFullyPaidStudents}`
      : 'Academy aggregate: UNAVAILABLE',
    sales?.academy.available
      ? `SLA eligible ${sales.academy.slaEligible} | ≤15m ${sales.academy.contactedWithin15Minutes} | ≤60m ${sales.academy.contactedWithin60Minutes} | missing ${sales.academy.slaMissing}`
      : undefined,
    '',
    'Telegram Ads boundary',
    'Moderation/status/spend: botda mavjud emas; ads.telegram.org kabinetida qo‘lda tekshiriladi.',
    'CAC/ROAS: ad spend integratsiyasisiz hisoblanmaydi.',
    snapshot.unavailableSections.length ? '' : undefined,
    snapshot.unavailableSections.length ? `Unavailable sections: ${snapshot.unavailableSections.join(', ')}` : undefined,
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

function summarizeContent(posts: ChannelPost[], now: Date): OperationalContentSnapshot {
  const counts = { ...EMPTY_CONTENT_COUNTS };
  for (const post of posts) {
    counts[post.status] += 1;
    if (post.status === 'Scheduled' && post.scheduledAt && new Date(post.scheduledAt) <= now) counts.due += 1;
  }
  const next = posts
    .filter((post) => post.status === 'Scheduled' && post.scheduledAt && new Date(post.scheduledAt) > now)
    .sort((left, right) => left.scheduledAt!.localeCompare(right.scheduledAt!))[0];
  return {
    available: true,
    counts,
    nextScheduledAt: next?.scheduledAt,
    nextContentKey: next?.contentKey,
  };
}

function unavailableContent(): OperationalContentSnapshot {
  return { available: false, counts: { ...EMPTY_CONTENT_COUNTS } };
}

function formatTashkentDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value)).replace(',', '');
}
