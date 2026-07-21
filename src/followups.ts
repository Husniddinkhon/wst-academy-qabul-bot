import type { Telegraf } from 'telegraf';
import { classifyPublicationFailure } from './channelPublisher.js';
import type { FollowUpDeliveryClaim, JsonFollowUpStore, JsonLeadStore } from './storage.js';
import type { BotContext, FollowUpState, Lead } from './types.js';

const INCOMPLETE_REGISTRATION_TEXT = 'Assalomu alaykum. WST Academy kursi bo‘yicha ro‘yxatdan o‘tishni boshlagan edingiz. Davom ettiramizmi?';
const WARM_NO_PHONE_TEXT = 'WST Academy kursiga qabul davom etmoqda. Kurs 1 oy, 12 dars, offline amaliyot. Savolingiz bo‘lsa, yozishingiz mumkin.';
const BLOCKED_STATUSES = new Set(['RegistrationCompleted', 'CallRequested', 'OperatorContacted', 'Paid', 'Rejected']);
export const FOLLOW_UP_TIME_ZONE = 'Asia/Tashkent';

export interface FollowUpAutomationOptions {
  pollMs?: number;
  claimLeaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  workerId?: string;
  now?: Date;
  canClaim?: () => boolean;
  runtime?: FollowUpRuntime;
}

export interface FollowUpRunResult { recovered: number; claimed: number; sent: number; retryWait: number; uncertain: number; failed: number; duplicatePrevented: number }
export interface FollowUpDrainResult { drained: boolean; timedOut: boolean; activeAtTimeout: number; durationMs: number }
export interface FollowUpAutomationHandle {
  readonly isAccepting: boolean;
  stopAccepting(): void;
  stopAndDrain(timeoutMs: number): Promise<FollowUpDrainResult>;
}

interface ActiveFollowUp { key: string; store: JsonFollowUpStore; claim: FollowUpDeliveryClaim }

export class FollowUpRuntime {
  private accepting = true;
  private readonly active = new Map<string, ActiveFollowUp>();
  private readonly waiters = new Set<() => void>();
  get isAccepting(): boolean { return this.accepting; }
  get activeCount(): number { return this.active.size; }
  stopAccepting(): void { this.accepting = false; }
  begin(store: JsonFollowUpStore, claim: FollowUpDeliveryClaim): string {
    if (!this.accepting) throw new Error('Follow-up worker is stopping and will not accept new claims.');
    const key = `${claim.followUpId}:${claim.claimToken}`;
    this.active.set(key, { key, store, claim });
    return key;
  }
  finish(key: string | undefined): void {
    if (!key) return;
    this.active.delete(key);
    if (this.active.size === 0) { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  }
  async drain(timeoutMs: number, now = new Date()): Promise<FollowUpDrainResult> {
    this.stopAccepting();
    const started = Date.now();
    if (this.active.size === 0) return { drained: true, timedOut: false, activeAtTimeout: 0, durationMs: Date.now() - started };
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      new Promise<true>((resolve) => this.waiters.add(() => resolve(true))),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (drained) return { drained: true, timedOut: false, activeAtTimeout: 0, durationMs: Date.now() - started };
    const remaining = [...this.active.values()];
    await Promise.allSettled(remaining.map((item) => item.store.abandonDeliveryForShutdown(item.claim, now)));
    return { drained: false, timedOut: true, activeAtTimeout: remaining.length, durationMs: Date.now() - started };
  }
}

export function startFollowUpAutomation(bot: Telegraf<BotContext>, leadStore: JsonLeadStore, followUpStore: JsonFollowUpStore, options: FollowUpAutomationOptions = {}): FollowUpAutomationHandle {
  const runtime = options.runtime ?? new FollowUpRuntime();
  let accepting = true;
  let currentRun: Promise<void> | undefined;
  const run = async () => {
    if (!accepting || currentRun) return;
    const result = await processFollowUps(bot, leadStore, followUpStore, { ...options, runtime, canClaim: () => accepting && runtime.isAccepting && (options.canClaim?.() ?? true) });
    if (result.recovered || result.claimed || result.failed || result.uncertain || result.retryWait || result.duplicatePrevented) console.info(JSON.stringify({ event: 'followup_scheduler_run', ...result }));
  };
  const invoke = () => {
    if (currentRun) return;
    currentRun = run().catch((error) => console.error('Follow-up automation failed:', error instanceof Error ? error.message : String(error))).finally(() => { currentRun = undefined; });
  };
  invoke();
  const timer = setInterval(invoke, options.pollMs ?? 15 * 60_000);
  return {
    get isAccepting() { return accepting; },
    stopAccepting() { accepting = false; runtime.stopAccepting(); clearInterval(timer); },
    async stopAndDrain(timeoutMs: number) {
      accepting = false;
      clearInterval(timer);
      runtime.stopAccepting();
      return runtime.drain(timeoutMs);
    },
  };
}

export async function processFollowUps(bot: Telegraf<BotContext>, leadStore: JsonLeadStore, followUpStore: JsonFollowUpStore, options: FollowUpAutomationOptions = {}): Promise<FollowUpRunResult> {
  const now = options.now ?? new Date();
  const runtime = options.runtime ?? new FollowUpRuntime();
  const result: FollowUpRunResult = { recovered: 0, claimed: 0, sent: 0, retryWait: 0, uncertain: 0, failed: 0, duplicatePrevented: 0 };
  result.recovered = (await followUpStore.recoverExpiredDeliveryClaims(now)).length;
  const tashkentHour = new Date(now.getTime() + 5 * 60 * 60_000).getUTCHours();
  if (tashkentHour < 9 || tashkentHour >= 20) return result;
  const states = await followUpStore.all();
  for (const state of states) {
    if (options.canClaim && !options.canClaim()) break;
    const lead = await leadStore.getByTelegramId(state.telegramId);
    if (lead && BLOCKED_STATUSES.has(lead.status)) { await followUpStore.cancelDelivery(state.telegramId, 'Lead reached a blocked/terminal admissions status.', now); continue; }
    const task = dueFollowUpTask(state, lead, now);
    if (!task) continue;
    const followUpId = `followup:${state.telegramId}:${state.count + 1}:${task.kind}`;
    const claimed = await followUpStore.claimDelivery({ telegramId: state.telegramId, followUpId, task: task.kind, dueAt: task.dueAt.toISOString(), timeZone: FOLLOW_UP_TIME_ZONE }, {
      workerId: options.workerId ?? `followup:${process.pid}`,
      leaseMs: options.claimLeaseMs ?? 5 * 60_000,
      maxAttempts: options.maxAttempts ?? 3,
      now,
    });
    if (!claimed.ok) { if (claimed.reason === 'owned' || claimed.reason === 'terminal') result.duplicatePrevented += 1; continue; }
    result.claimed += 1;
    let runtimeKey: string | undefined;
    try {
      runtimeKey = runtime.begin(followUpStore, claimed.claim);
      const sending = await followUpStore.markDeliverySending(claimed.claim, now);
      if (!sending) throw new Error('Follow-up claim ownership changed before Telegram send.');
      await bot.telegram.sendMessage(state.telegramId, task.text);
      const completed = await followUpStore.finishDelivery(claimed.claim, { sent: true }, new Date());
      if (!completed) throw new Error('Follow-up delivery ownership changed after Telegram response.');
      result.sent += 1;
      if (lead) await leadStore.updateByTelegramId(lead.telegramId, { agentActionCount: (lead.agentActionCount ?? 0) + 1, lastAgentAction: 'Automated follow-up', lastAgentAt: completed.lastSentAt }, `${followUpId}:lead-audit`);
    } catch (error) {
      const disposition = classifyFollowUpFailure(error);
      const retryMs = Math.min(options.retryMaxMs ?? 60 * 60_000, (options.retryBaseMs ?? 5 * 60_000) * (2 ** Math.max(0, claimed.claim.attempt - 1)));
      const completed = await followUpStore.finishDelivery(claimed.claim, {
        sent: false,
        category: disposition,
        error: safeError(error),
        nextRetryAt: new Date(now.getTime() + retryMs),
        maxAttempts: options.maxAttempts ?? 3,
      }, now);
      if (completed?.deliveryState === 'RetryWait') result.retryWait += 1;
      else if (completed?.deliveryState === 'Uncertain') result.uncertain += 1;
      else if (completed?.deliveryState === 'Failed') result.failed += 1;
    } finally { runtime.finish(runtimeKey); }
  }
  return result;
}

function dueFollowUpTask(state: FollowUpState, lead: Lead | undefined, now: Date): { kind: NonNullable<FollowUpState['task']>; dueAt: Date; text: string } | undefined {
  if (state.registrationCompleted || state.count >= 2 || ['Uncertain', 'Failed', 'Cancelled'].includes(state.deliveryState ?? '')) return undefined;
  const repeatDue = state.lastSentAt ? new Date(new Date(state.lastSentAt).getTime() + 24 * 60 * 60_000) : undefined;
  const registrationDue = new Date(new Date(state.startedAt).getTime() + 2 * 60 * 60_000);
  if (!state.registrationCompleted) {
    const dueAt = repeatDue && repeatDue > registrationDue ? repeatDue : registrationDue;
    if (dueAt <= now) return { kind: 'registration_incomplete', dueAt, text: INCOMPLETE_REGISTRATION_TEXT };
  }
  if (lead?.status === 'Warm' && !lead.phone) {
    const warmDue = new Date(new Date(lead.updatedAt).getTime() + 24 * 60 * 60_000);
    const dueAt = repeatDue && repeatDue > warmDue ? repeatDue : warmDue;
    if (dueAt <= now) return { kind: 'warm_no_phone', dueAt, text: WARM_NO_PHONE_TEXT };
  }
  return undefined;
}

function classifyFollowUpFailure(error: unknown): 'transient' | 'permanent' | 'uncertain' {
  const result = classifyPublicationFailure(error, true);
  if (result.kind === 'failed' && result.category === 'telegram_rejection') return 'permanent';
  if (result.kind === 'retry_wait') return 'transient';
  return 'uncertain';
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
