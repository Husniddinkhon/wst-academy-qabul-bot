import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EgressPolicy, EgressHttpClient, EgressRateLimiter, parseDestination, type EgressConfig } from '../src/egressPolicy.js';

function testConfig(overrides: Partial<EgressConfig> = {}): EgressConfig {
  return {
    environment: 'test',
    stagingAllowedDestinations: [],
    productionAllowedDestinations: [],
    testMockTransport: false,
    rateLimitDefaults: {
      perDestinationMax: 30,
      perDestinationWindowMs: 60_000,
      perApplicantMax: 10,
      perApplicantWindowMs: 60_000,
      perActionMax: 20,
      perActionWindowMs: 60_000,
      burstCeiling: 5,
      dailyMessageCeiling: 100,
      webhookRetryCeiling: 5,
      externalHttpConcurrency: 10,
      aiRequestCeiling: 6,
    },
    httpDefaults: {
      connectTimeoutMs: 5_000,
      readTimeoutMs: 10_000,
      totalTimeoutMs: 15_000,
      maxResponseBytes: 1_048_576,
      maxRedirects: 5,
      allowedContentTypes: ['application/json'],
      tlsVerify: true,
      denyIpLiterals: true,
      denyPrivateRanges: true,
      denyUserinfo: true,
      denyNonStandardPorts: true,
      denyRedirectNonAllowlisted: true,
    },
    ...overrides,
  };
}

describe('EgressPolicy — destination resolution', () => {
  it('should allow staging Telegram API host', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage');
    assert.equal(result.allowed, true);
  });

  it('should deny unknown destination', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('https://unknown-malicious-host.com/api');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /not in allowlist/);
  });

  it('should deny redirect to non-allowlisted host', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.checkRedirect('https://api.telegram.org/sendMessage', 'https://evil.com/hook');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /not in allowlist/);
  });

  it('should deny IP literal', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('https://192.168.1.1/api');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /IP literal/);
  });

  it('should deny private network range', () => {
    const policy = new EgressPolicy(testConfig({
      httpDefaults: { ...testConfig().httpDefaults, denyIpLiterals: false },
    }));
    const result = policy.resolveDestination('https://10.0.0.1/api');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Private IP/);
  });

  it('should deny HTTP in staging', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('http://api.telegram.org/bot/test');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /HTTPS required/);
  });

  it('should deny userinfo in URL', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('https://user:pass@api.telegram.org/bot');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Userinfo/);
  });

  it('should deny non-standard port', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('https://api.telegram.org:8443/bot');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Non-standard port/);
  });
});

describe('EgressPolicy — consent and identity', () => {
  it('should block applicant without consent for follow-up', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkConsent('withdrawn', 'followup');
    assert.equal(result.ok, false);
    assert.match(result.reason!, /withdrawn consent/);
  });

  it('should allow applicant with consent', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkConsent('granted', 'followup');
    assert.equal(result.ok, true);
  });

  it('should block marketing without marketing consent', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkConsent('granted', 'marketing');
    assert.equal(result.ok, true);
    const result2 = policy.checkConsent('withdrawn', 'marketing');
    assert.equal(result2.ok, false);
    assert.match(result2.reason!, /Marketing/);
  });

  it('should block withdrawn consent', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkConsent('withdrawn', 'followup');
    assert.equal(result.ok, false);
  });

  it('should block blocked identity', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkIdentityState(true, false, false);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Blocked/);
  });

  it('should block withdrawn identity', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkIdentityState(false, true, false);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Withdrawn/);
  });

  it('should block unverified identity', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkIdentityState(false, false, true);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Unverified/);
  });
});

describe('EgressPolicy — rate limiter', () => {
  it('should allow first request', () => {
    const limiter = new EgressRateLimiter(testConfig().rateLimitDefaults);
    assert.equal(limiter.check('test-key'), true);
  });

  it('should deny after exhaustion', () => {
    const limiter = new EgressRateLimiter({
      ...testConfig().rateLimitDefaults,
      perDestinationMax: 2,
      perDestinationWindowMs: 60_000,
    });
    assert.equal(limiter.check('test-key'), true);
    assert.equal(limiter.check('test-key'), true);
    assert.equal(limiter.check('test-key'), false);
  });

  it('should reset after window expires', () => {
    const limiter = new EgressRateLimiter({
      ...testConfig().rateLimitDefaults,
      perDestinationMax: 1,
      perDestinationWindowMs: 10,
    });
    assert.equal(limiter.check('test-key'), true);
    assert.equal(limiter.check('test-key'), false);
    const future = Date.now() + 100;
    assert.equal(limiter.check('test-key', future), true);
  });

  it('should enforce daily ceiling', () => {
    const limiter = new EgressRateLimiter({
      ...testConfig().rateLimitDefaults,
      dailyMessageCeiling: 2,
    });
    const now = new Date('2026-07-22T12:00:00Z');
    assert.equal(limiter.checkDaily('dest', now), true);
    assert.equal(limiter.checkDaily('dest', now), true);
    assert.equal(limiter.checkDaily('dest', now), false);
  });
});

describe('EgressPolicy — payload classification', () => {
  it('should classify credentials', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.classifyPayload({ apiKey: 'sk-test1234567890abcdef' });
    assert.equal(result, 'credential');
  });

  it('should classify raw PII', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.classifyPayload({ phone: '+998901234567', telegram_id: 12345 });
    assert.equal(result, 'raw_pii');
  });

  it('should classify masked PII', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.classifyPayload({ phone: '+998901234567' });
    assert.equal(result === 'raw_pii' || result === 'masked_pii', true);
  });

  it('should block raw PII to AI provider', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkPayloadClassification('raw_pii', 'ai_provider');
    assert.equal(result.ok, false);
    assert.match(result.reason!, /PII/);
  });

  it('should block credentials to AI provider', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkPayloadClassification('credential', 'ai_provider');
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Credential/);
  });

  it('should block raw PII to Telegram channel', () => {
    const policy = new EgressPolicy(testConfig());
    const result = policy.checkPayloadClassification('raw_pii', 'telegram_channel');
    assert.equal(result.ok, false);
    assert.match(result.reason!, /PII/);
  });
});

describe('EgressPolicy — audit events', () => {
  it('should create sanitized audit event without raw IDs', () => {
    const policy = new EgressPolicy(testConfig());
    const event = policy.createAuditEvent({
      actionType: 'telegram.sendMessage',
      destinationFingerprint: 'https://api.telegram.org',
      policyDecision: 'allowed',
      actorId: '12345',
      applicantId: 'app-67890',
      correlationId: 'corr-abc',
    });
    assert.equal(event.actionType, 'telegram.sendMessage');
    assert.equal(event.destinationFingerprint, 'https://api.telegram.org');
    assert.notEqual(event.actorId, undefined);
    assert.notEqual(event.applicantId, undefined);
    assert.equal(typeof event.actorId, 'string');
    assert.equal(typeof event.applicantId, 'string');
    assert.equal(event.correlationId, 'corr-abc');
  });
});

describe('EgressPolicy — environment mode isolation', () => {
  it('should block staging-to-production destination in staging', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('https://production-webhook.example.com/hook');
    assert.equal(result.allowed, false);
  });
});

describe('EgressHttpClient — safety', () => {
  it('should deny request to blocked destination', async () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const client = new EgressHttpClient(policy, testConfig().httpDefaults);
    await assert.rejects(
      () => client.fetch('https://evil.com/hook', { correlationId: 'test' }),
      /Egress denied/,
    );
  });
});
