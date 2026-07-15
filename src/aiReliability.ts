export type AiProviderOutcome = 'success' | 'http_error' | 'timeout' | 'network_error' | 'empty_response' | 'circuit_open' | 'rate_limited';

export interface AiReliabilityControls {
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  circuitFailureThreshold: number;
  circuitBaseBackoffMs: number;
  circuitMaxBackoffMs: number;
}

export interface AiProviderIdentity {
  provider: string;
  model: string;
}

export interface AiTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiProviderMetrics {
  provider: string;
  model: string;
  attempts: number;
  successes: number;
  failures: number;
  timeouts: number;
  circuitSkips: number;
  rateLimited: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  circuitOpenUntil?: number;
}

interface RateWindow { startedAt: number; count: number }
interface CircuitState { consecutiveFailures: number; openCount: number; openUntil: number; probeInFlight: boolean }

export class AiRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('AI per-user rate limit exceeded.');
    this.name = 'AiRateLimitError';
  }
}

export class AiCircuitOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('AI provider circuit is temporarily open.');
    this.name = 'AiCircuitOpenError';
  }
}

export class AiReliabilityController {
  private readonly rateWindows = new Map<string, RateWindow>();
  private readonly circuits = new Map<string, CircuitState>();
  private readonly metrics = new Map<string, AiProviderMetrics>();
  private rateChecks = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly logger: (record: Record<string, unknown>) => void = (record) => console.info(JSON.stringify(record)),
  ) {}

  consumeRateLimit(actorId: string | undefined, provider: AiProviderIdentity, controls: AiReliabilityControls): void {
    if (!actorId?.trim()) return;
    const now = this.clock();
    const current = this.rateWindows.get(actorId);
    const window = !current || now - current.startedAt >= controls.rateLimitWindowMs
      ? { startedAt: now, count: 0 }
      : current;
    if (window.count >= controls.rateLimitMaxRequests) {
      const retryAfterMs = Math.max(1, controls.rateLimitWindowMs - (now - window.startedAt));
      this.record(provider, 'rate_limited', 0);
      throw new AiRateLimitError(retryAfterMs);
    }
    window.count += 1;
    this.rateWindows.set(actorId, window);
    this.rateChecks += 1;
    if (this.rateChecks % 100 === 0) this.pruneRateWindows(now, controls.rateLimitWindowMs);
  }

  beforeProvider(provider: AiProviderIdentity): { probe: boolean; startedAt: number } {
    const now = this.clock();
    const circuit = this.circuits.get(keyOf(provider));
    if (!circuit?.openUntil) return { probe: false, startedAt: now };
    if (circuit.openUntil > now || circuit.probeInFlight) {
      const retryAfterMs = Math.max(1, circuit.openUntil - now);
      this.record(provider, 'circuit_open', 0);
      throw new AiCircuitOpenError(retryAfterMs);
    }
    circuit.probeInFlight = true;
    return { probe: true, startedAt: now };
  }

  finishProvider(
    provider: AiProviderIdentity,
    attempt: { probe: boolean; startedAt: number },
    outcome: Exclude<AiProviderOutcome, 'circuit_open' | 'rate_limited'>,
    controls: AiReliabilityControls,
    usage?: AiTokenUsage,
  ): void {
    const now = this.clock();
    this.record(provider, outcome, Math.max(0, now - attempt.startedAt), usage);
    const key = keyOf(provider);
    const state = this.circuits.get(key) ?? { consecutiveFailures: 0, openCount: 0, openUntil: 0, probeInFlight: false };
    state.probeInFlight = false;
    if (outcome === 'success') {
      state.consecutiveFailures = 0;
      state.openCount = 0;
      state.openUntil = 0;
      this.circuits.set(key, state);
      return;
    }
    state.consecutiveFailures += 1;
    if (attempt.probe || state.consecutiveFailures >= controls.circuitFailureThreshold) {
      state.openCount += 1;
      const backoff = Math.min(
        controls.circuitBaseBackoffMs * 2 ** Math.max(0, state.openCount - 1),
        controls.circuitMaxBackoffMs,
      );
      state.openUntil = now + backoff;
      state.consecutiveFailures = 0;
    }
    this.circuits.set(key, state);
  }

  snapshot(): AiProviderMetrics[] {
    return [...this.metrics.values()].map((metric) => ({
      ...metric,
      circuitOpenUntil: this.circuits.get(keyOf(metric))?.openUntil || undefined,
    })).sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  }

  reset(): void {
    this.rateWindows.clear();
    this.circuits.clear();
    this.metrics.clear();
    this.rateChecks = 0;
  }

  private record(provider: AiProviderIdentity, outcome: AiProviderOutcome, latencyMs: number, usage?: AiTokenUsage): void {
    const key = keyOf(provider);
    const metric = this.metrics.get(key) ?? {
      ...provider,
      attempts: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      circuitSkips: 0,
      rateLimited: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    if (outcome !== 'circuit_open' && outcome !== 'rate_limited') metric.attempts += 1;
    if (outcome === 'success') metric.successes += 1;
    else if (outcome === 'circuit_open') metric.circuitSkips += 1;
    else if (outcome === 'rate_limited') metric.rateLimited += 1;
    else metric.failures += 1;
    if (outcome === 'timeout') metric.timeouts += 1;
    metric.totalLatencyMs += latencyMs;
    metric.lastLatencyMs = latencyMs;
    metric.promptTokens += safeTokenCount(usage?.promptTokens);
    metric.completionTokens += safeTokenCount(usage?.completionTokens);
    metric.totalTokens += safeTokenCount(usage?.totalTokens);
    this.metrics.set(key, metric);
    this.logger({
      event: 'ai_provider_outcome',
      provider: provider.provider,
      model: provider.model,
      outcome,
      latency_ms: latencyMs,
      attempts: metric.attempts,
      successes: metric.successes,
      failures: metric.failures,
      timeouts: metric.timeouts,
      circuit_skips: metric.circuitSkips,
      rate_limited: metric.rateLimited,
      prompt_tokens: metric.promptTokens,
      completion_tokens: metric.completionTokens,
      total_tokens: metric.totalTokens,
    });
  }

  private pruneRateWindows(now: number, windowMs: number): void {
    for (const [actorId, window] of this.rateWindows) {
      if (now - window.startedAt >= windowMs) this.rateWindows.delete(actorId);
    }
  }
}

function keyOf(provider: AiProviderIdentity): string {
  return `${provider.provider}\u0000${provider.model}`;
}

function safeTokenCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 0;
}
