import { createHash } from 'node:crypto';

// ─── Environment modes ─────────────────────────────────────────────────────

export type EnvironmentMode = 'development' | 'test' | 'staging' | 'production';

// ─── Destination types ─────────────────────────────────────────────────────

export type DestinationType =
  | 'telegram_api'
  | 'telegram_channel'
  | 'telegram_bot'
  | 'webhook'
  | 'ai_provider'
  | 'http_api'
  | 'database'
  | 'localhost_test';

// ─── Action types ──────────────────────────────────────────────────────────

export type EgressActionType =
  | 'telegram.sendMessage'
  | 'telegram.sendPhoto'
  | 'telegram.sendDocument'
  | 'telegram.editMessage'
  | 'telegram.deleteMessage'
  | 'telegram.setMyCommands'
  | 'telegram.setMyDescription'
  | 'webhook.deliver'
  | 'webhook.retry'
  | 'ai.completion'
  | 'ai.fallback.completion'
  | 'http.fetch'
  | 'database.connect'
  | 'channel.publish'
  | 'channel.schedule'
  | 'admin.notify'
  | 'followup.send'
  | 'daily.report';

// ─── Destination identity ─────────────────────────────────────────────────

export interface DestinationIdentity {
  host: string;
  port?: number;
  protocol: 'https' | 'http';
  pathPrefix?: string;
  originalUrl?: string;
}

export function parseDestination(url: string): DestinationIdentity {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port ? Number(parsed.port) : undefined,
      protocol: parsed.protocol === 'http:' ? 'http' : 'https',
      pathPrefix: parsed.pathname,
      originalUrl: url,
    };
  } catch {
    return { host: 'unknown', protocol: 'https', originalUrl: url };
  }
}

// ─── Allowlist entry ────────────────────────────────────────────────────────

export interface AllowlistEntry {
  host: string;
  port?: number;
  protocol?: 'https' | 'http';
  pathPrefix?: string;
  description: string;
}

// ─── Policy decision ────────────────────────────────────────────────────────

export type PolicyDecision =
  | { allowed: true; destination: DestinationIdentity; mode: EnvironmentMode }
  | { allowed: false; reason: string; destination: DestinationIdentity; mode: EnvironmentMode };

// ─── Actor authorization ────────────────────────────────────────────────────

export interface EgressActor {
  actorId: string;
  role?: string;
}

// ─── Applicant consent state ────────────────────────────────────────────────

export type ConsentState = 'granted' | 'withdrawn' | 'not_required' | 'unknown';

// ─── Payload classification ─────────────────────────────────────────────────

export type PayloadClassification = 'public' | 'internal_non_sensitive' | 'masked_pii' | 'raw_pii' | 'credential';

// ─── Rate limit bucket ──────────────────────────────────────────────────────

export interface RateLimitBucket {
  key: string;
  maxRequests: number;
  windowMs: number;
  tokens: number;
  resetAt: number;
}

// ─── Audit event ────────────────────────────────────────────────────────────

export interface EgressAuditEvent {
  actionType: EgressActionType;
  destinationFingerprint: string;
  environment: EnvironmentMode;
  policyDecision: 'allowed' | 'denied';
  actorId?: string;
  applicantId?: string;
  purpose?: string;
  consentVersion?: string;
  correlationId: string;
  retryCount?: number;
  timestamp: string;
  failureClass?: string;
}

// ─── Egress configuration ───────────────────────────────────────────────────

export interface EgressConfig {
  environment: EnvironmentMode;
  stagingAllowedDestinations: AllowlistEntry[];
  productionAllowedDestinations: AllowlistEntry[];
  testMockTransport: boolean;
  rateLimitDefaults: {
    perDestinationMax: number;
    perDestinationWindowMs: number;
    perApplicantMax: number;
    perApplicantWindowMs: number;
    perActionMax: number;
    perActionWindowMs: number;
    burstCeiling: number;
    dailyMessageCeiling: number;
    webhookRetryCeiling: number;
    externalHttpConcurrency: number;
    aiRequestCeiling: number;
  };
  httpDefaults: {
    connectTimeoutMs: number;
    readTimeoutMs: number;
    totalTimeoutMs: number;
    maxResponseBytes: number;
    maxRedirects: number;
    allowedContentTypes: string[];
    tlsVerify: boolean;
    denyIpLiterals: boolean;
    denyPrivateRanges: boolean;
    denyUserinfo: boolean;
    denyNonStandardPorts: boolean;
    denyRedirectNonAllowlisted: boolean;
  };
}

// ─── Destination allowlists ─────────────────────────────────────────────────

const STAGING_TELEGRAM_API: AllowlistEntry[] = [
  { host: 'api.telegram.org', protocol: 'https', description: 'Telegram Bot API' },
];

const STAGING_WEBHOOK_HOSTS: AllowlistEntry[] = [
  { host: 'webhook.site', protocol: 'https', description: 'Test webhook receiver' },
  { host: 'localhost', port: 8381, protocol: 'http', description: 'Local Ops Aggregate dev' },
];

const STAGING_API_HOSTS: AllowlistEntry[] = [
  { host: 'api.openai.com', protocol: 'https', description: 'OpenAI (staging AI)' },
];

const STAGING_AI_HOSTS: AllowlistEntry[] = [
  { host: 'api.openai.com', protocol: 'https', description: 'OpenAI compatible provider' },
];

const STAGING_CHANNEL_CHAT_ID_PLACEHOLDER = 'staging_channel';

const PRODUCTION_TELEGRAM_API: AllowlistEntry[] = [
  { host: 'api.telegram.org', protocol: 'https', description: 'Telegram Bot API' },
];

const PRODUCTION_WEBHOOK_HOSTS: AllowlistEntry[] = [
];

const PRODUCTION_AI_HOSTS: AllowlistEntry[] = [
];

const TEST_LOCALHOST: AllowlistEntry[] = [
  { host: 'localhost', port: 1, protocol: 'http', description: 'Test harness' },
  { host: '127.0.0.1', port: 1, protocol: 'http', description: 'Test harness' },
];

// ─── Private IP range check ─────────────────────────────────────────────────

const PRIVATE_RANGES = [
  { prefix: '10.', mask: 8 },
  { prefix: '172.16.', mask: 12 },
  { prefix: '192.168.', mask: 16 },
  { prefix: '127.', mask: 8 },
  { prefix: '169.254.', mask: 16 },
  { prefix: '0.', mask: 8 },
];

function isPrivateIp(host: string): boolean {
  return PRIVATE_RANGES.some((range) => host.startsWith(range.prefix));
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || /^\[/.test(host);
}

// ─── Rate limiter ───────────────────────────────────────────────────────────

export class EgressRateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private dailyCounters = new Map<string, { date: string; count: number }>();

  constructor(private config: EgressConfig['rateLimitDefaults']) {}

  check(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, {
        key,
        maxRequests: this.config.perDestinationMax,
        windowMs: this.config.perDestinationWindowMs,
        tokens: this.config.perDestinationMax - 1,
        resetAt: now + this.config.perDestinationWindowMs,
      });
      return true;
    }
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  checkDaily(destinationKey: string, now: Date = new Date()): boolean {
    const dateStr = now.toISOString().slice(0, 10);
    const existing = this.dailyCounters.get(destinationKey);
    if (!existing || existing.date !== dateStr) {
      this.dailyCounters.set(destinationKey, { date: dateStr, count: 1 });
      return true;
    }
    if (existing.count < this.config.dailyMessageCeiling) {
      existing.count += 1;
      return true;
    }
    return false;
  }

  checkBurst(key: string, now: number = Date.now()): boolean {
    return this.check(`burst:${key}`, now);
  }
}

// ─── Audit event persistence ─────────────────────────────────────────────────

export type EgressAuditSink = (event: EgressAuditEvent) => void | Promise<void>;

// ─── Central egress policy engine ───────────────────────────────────────────

export class EgressPolicy {
  private rateLimiter: EgressRateLimiter;
  private auditSink: EgressAuditSink | undefined;

  constructor(
    private config: EgressConfig,
    auditSink?: EgressAuditSink,
  ) {
    this.rateLimiter = new EgressRateLimiter(config.rateLimitDefaults);
    this.auditSink = auditSink;
  }

  setAuditSink(sink: EgressAuditSink | undefined): void { this.auditSink = sink; }

  getRateLimiter(): EgressRateLimiter {
    return this.rateLimiter;
  }

  private allowlistForMode(): AllowlistEntry[] {
    switch (this.config.environment) {
      case 'development':
      case 'test':
        return [...TEST_LOCALHOST, ...STAGING_TELEGRAM_API];
      case 'staging':
        return [
          ...STAGING_TELEGRAM_API,
          ...STAGING_WEBHOOK_HOSTS,
          ...STAGING_API_HOSTS,
          ...STAGING_AI_HOSTS,
        ];
      case 'production':
        return [
          ...PRODUCTION_TELEGRAM_API,
          ...PRODUCTION_WEBHOOK_HOSTS,
          ...PRODUCTION_AI_HOSTS,
        ];
    }
  }

  /**
   * Check whether a destination is allowlisted for the current environment.
   */
  resolveDestination(url: string): PolicyDecision {
    const destination = parseDestination(url);
    const mode = this.config.environment;

    if (mode !== 'test' && destination.protocol !== 'https') {
      return { allowed: false, reason: 'HTTPS required except in test mode', destination, mode };
    }

    if (this.config.httpDefaults.denyIpLiterals && isIpLiteral(destination.host)) {
      return { allowed: false, reason: 'IP literals denied by policy', destination, mode };
    }

    if (this.config.httpDefaults.denyPrivateRanges && isPrivateIp(destination.host)) {
      return { allowed: false, reason: 'Private IP range denied by policy', destination, mode };
    }

    if (this.config.httpDefaults.denyNonStandardPorts && destination.port && ![443, 80].includes(destination.port)) {
      return { allowed: false, reason: `Non-standard port ${destination.port} denied by policy`, destination, mode };
    }

    if (this.config.httpDefaults.denyUserinfo && destination.originalUrl) {
      try {
        const parsed = new URL(destination.originalUrl);
        if (parsed.username || parsed.password) {
          return { allowed: false, reason: 'Userinfo in URL denied by policy', destination, mode };
        }
      } catch {
      }
    }

    const allowlist = this.allowlistForMode();
    const matched = allowlist.some((entry) => {
      if (entry.host !== destination.host) return false;
      if (entry.port !== undefined && entry.port !== destination.port) return false;
      if (entry.protocol !== undefined && entry.protocol !== destination.protocol) return false;
      if (entry.pathPrefix !== undefined && !destination.pathPrefix?.startsWith(entry.pathPrefix)) return false;
      return true;
    });

    if (!matched) {
      return { allowed: false, reason: `Destination ${destination.host} not in allowlist for ${mode}`, destination, mode };
    }

    return { allowed: true, destination, mode };
  }

  /**
   * Authorize an action for the given actor.
   */
  authorizeAction(
    actor: EgressActor | undefined,
    actionType: EgressActionType,
    destination: DestinationIdentity,
  ): PolicyDecision {
    const url = destination.originalUrl ?? `https://${destination.host}`;
    const base = this.resolveDestination(url);
    if (!base.allowed) return base;

    if (actionType === 'admin.notify' && !actor) {
      return { allowed: false, reason: 'Admin notification requires an actor', destination, mode: this.config.environment };
    }

    if (actionType.startsWith('telegram.') && this.config.environment === 'staging') {
      return { allowed: true, destination, mode: this.config.environment };
    }

    return { allowed: true, destination, mode: this.config.environment };
  }

  /**
   * Check applicant consent for the given purpose.
   */
  checkConsent(consentState: ConsentState, purpose: string): { ok: boolean; reason?: string } {
    if (purpose === 'followup' && consentState === 'withdrawn') {
      return { ok: false, reason: 'Applicant has withdrawn consent for follow-ups' };
    }
    if (purpose === 'marketing' && consentState !== 'granted') {
      return { ok: false, reason: 'Marketing requires explicit consent' };
    }
    if (purpose === 'public_data' && consentState === 'unknown') {
      return { ok: false, reason: 'Consent state unknown for public data processing' };
    }
    return { ok: true };
  }

  /**
   * Check whether applicant identity allows outbound communication.
   */
  checkIdentityState(
    blocked: boolean,
    withdrawn: boolean,
    unverified: boolean,
  ): { ok: boolean; reason?: string } {
    if (blocked) return { ok: false, reason: 'Blocked identity' };
    if (withdrawn) return { ok: false, reason: 'Withdrawn identity' };
    if (unverified) return { ok: false, reason: 'Unverified identity' };
    return { ok: true };
  }

  /**
   * Classify payload for AI/data egress.
   */
  classifyPayload(payload: unknown): PayloadClassification {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!str) return 'public';
    if (/eyJ|sk-[a-zA-Z0-9]{16,}|BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/i.test(str)) return 'credential';
    if (/(?:^|[^a-z])(phone|telegram_id|passport)(?:$|[^a-z])/i.test(str) && /\+?\d{7,}/.test(str)) return 'raw_pii';
    if (/\+998\d{9}|@[a-z0-9_]{3,}/i.test(str)) return 'masked_pii';
    return 'internal_non_sensitive';
  }

  /**
   * Check whether the payload may be sent to the given destination type.
   */
  checkPayloadClassification(
    classification: PayloadClassification,
    destinationType: DestinationType,
  ): { ok: boolean; reason?: string } {
    if (destinationType === 'ai_provider' && classification === 'raw_pii') {
      return { ok: false, reason: 'Raw PII must not be sent to AI providers' };
    }
    if (destinationType === 'ai_provider' && classification === 'credential') {
      return { ok: false, reason: 'Credentials must not be sent to AI providers' };
    }
    if (destinationType === 'telegram_channel' && classification === 'raw_pii') {
      return { ok: false, reason: 'Raw PII must not be published to Telegram channels' };
    }
    return { ok: true };
  }

  /**
   * Redirect safety: check that redirect target is also allowlisted.
   */
  checkRedirect(originalUrl: string, redirectTarget: string): PolicyDecision {
    const originalDecision = this.resolveDestination(originalUrl);
    if (!originalDecision.allowed) return originalDecision;
    if (this.config.httpDefaults.denyRedirectNonAllowlisted) {
      const redirectDecision = this.resolveDestination(redirectTarget);
      if (!redirectDecision.allowed) {
        return { allowed: false, reason: `Redirect to non-allowlisted destination: ${redirectDecision.reason}`, destination: redirectDecision.destination, mode: this.config.environment };
      }
    }
    return { allowed: true, destination: originalDecision.destination, mode: this.config.environment };
  }

  /**
   * Create a sanitized audit event for any egress action.
   */
  createAuditEvent(params: {
    actionType: EgressActionType;
    destinationFingerprint: string;
    policyDecision: 'allowed' | 'denied';
    actorId?: string;
    applicantId?: string;
    purpose?: string;
    consentVersion?: string;
    correlationId: string;
    retryCount?: number;
    failureClass?: string;
  }): EgressAuditEvent {
    const event: EgressAuditEvent = {
      actionType: params.actionType,
      destinationFingerprint: params.destinationFingerprint,
      environment: this.config.environment,
      policyDecision: params.policyDecision,
      actorId: params.actorId ? hashAuditId(params.actorId) : undefined,
      applicantId: params.applicantId ? hashAuditId(params.applicantId) : undefined,
      purpose: params.purpose,
      consentVersion: params.consentVersion,
      correlationId: params.correlationId,
      retryCount: params.retryCount,
      timestamp: new Date().toISOString(),
      failureClass: params.failureClass,
    };
    if (this.auditSink) {
      try {
        void this.auditSink(event);
      } catch {
      }
    }
    return event;
  }
}

function hashAuditId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
}

// ─── Safe HTTP egress client ────────────────────────────────────────────────

export interface SafeHttpResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
  redirected: boolean;
  url: string;
}

export class EgressHttpClient {
  constructor(
    private policy: EgressPolicy,
    private config: EgressConfig['httpDefaults'],
  ) {}

  async fetch(
    url: string,
    options: RequestInit & {
      actionType?: EgressActionType;
      actor?: EgressActor;
      correlationId?: string;
      destinationType?: DestinationType;
      payloadClassification?: PayloadClassification;
    } = {},
  ): Promise<SafeHttpResponse> {
    const destination = parseDestination(url);
    const actionType = options.actionType ?? 'http.fetch';
    const correlationId = options.correlationId ?? 'unknown';
    const correlation = correlationId;

    const decision = this.policy.authorizeAction(options.actor, actionType, destination);
    if (!decision.allowed) {
      this.policy.createAuditEvent({
        actionType,
        destinationFingerprint: fingerprint(destination),
        policyDecision: 'denied',
        actorId: options.actor?.actorId,
        correlationId: correlation,
        failureClass: 'egress_denied',
      });
      throw new Error(`Egress denied: ${decision.reason}`);
    }

    if (this.config.denyUserinfo) {
      try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
          throw new Error('Userinfo in URL denied by policy');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Userinfo in URL denied by policy') throw error;
      }
    }

    const controller = new AbortController();
    const totalTimeout = setTimeout(() => controller.abort(), this.config.totalTimeoutMs);
    const mergedOptions: RequestInit = {
      ...options,
      signal: controller.signal,
      redirect: 'manual' as RequestRedirect,
    };
    delete (mergedOptions as Record<string, unknown>).actionType;
    delete (mergedOptions as Record<string, unknown>).actor;
    delete (mergedOptions as Record<string, unknown>).correlationId;
    delete (mergedOptions as Record<string, unknown>).destinationType;
    delete (mergedOptions as Record<string, unknown>).payloadClassification;

    try {
      const response = await fetch(url, mergedOptions);
      clearTimeout(totalTimeout);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          const resolvedLocation = new URL(location, url).toString();
          const redirectDecision = this.policy.checkRedirect(url, resolvedLocation);
          if (!redirectDecision.allowed) {
            throw new Error(`Redirect rejected: ${redirectDecision.reason}`);
          }
          return this.fetch(resolvedLocation, { ...options, redirect: 'follow' });
        }
      }

      if (this.config.maxRedirects !== undefined) {
        let redirectCount = 0;
        let currentResponse = response;
        while (currentResponse.status >= 300 && currentResponse.status < 400 && redirectCount < this.config.maxRedirects) {
          const location = currentResponse.headers.get('location');
          if (!location) break;
          const resolvedLocation = new URL(location, url).toString();
          const redirectDecision = this.policy.checkRedirect(url, resolvedLocation);
          if (!redirectDecision.allowed) {
            throw new Error(`Redirect rejected: ${redirectDecision.reason}`);
          }
          currentResponse = await fetch(resolvedLocation, { ...mergedOptions, redirect: 'follow' });
          redirectCount += 1;
        }
        return responseToSafe(redirectCount > 0 ? currentResponse : response);
      }

      return responseToSafe(response);
    } catch (error) {
      clearTimeout(totalTimeout);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Egress HTTP timeout after ${this.config.totalTimeoutMs}ms`);
      }
      throw error;
    }
  }
}

async function responseToSafe(response: globalThis.Response): Promise<SafeHttpResponse> {
  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body,
    redirected: response.redirected,
    url: response.url,
  };
}

function fingerprint(destination: DestinationIdentity): string {
  return `${destination.protocol}://${destination.host}${destination.port ? `:${destination.port}` : ''}`;
}
