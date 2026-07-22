import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EgressPolicy, EgressHttpClient, type EgressConfig } from '../src/egressPolicy.js';

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

describe('Egress integration — audit persistence', () => {
  const auditFile = join(process.cwd(), 'data', `test-egress-audit-${Date.now()}.ndjson`);

  after(() => {
    try { unlinkSync(auditFile); } catch { }
    try { unlinkSync(join(process.cwd(), 'data', `${auditFile.split(/[/\\]/).pop()!}`)); } catch { }
  });

  it('should persist audit events to file via sink', () => {
    const events: unknown[] = [];
    const policy = new EgressPolicy(testConfig(), (event) => {
      events.push(event);
      const dir = auditFile.substring(0, Math.max(auditFile.lastIndexOf('/'), auditFile.lastIndexOf('\\')));
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(auditFile, JSON.stringify(event) + '\n', 'utf-8');
    });
    const event = policy.createAuditEvent({
      actionType: 'telegram.sendMessage',
      destinationFingerprint: 'https://api.telegram.org',
      policyDecision: 'allowed',
      correlationId: 'test-audit-1',
    });
    const content = readFileSync(auditFile, 'utf-8').trim();
    assert.ok(content.length > 0);
    const parsed = JSON.parse(content);
    assert.equal(parsed.actionType, 'telegram.sendMessage');
    assert.equal(parsed.policyDecision, 'allowed');
    assert.equal(parsed.correlationId, 'test-audit-1');
    assert.ok(parsed.timestamp);
  });
});

describe('Egress integration — Telegram callApi wrapper', () => {
  it('should deny callApi when destination is not allowlisted', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'production' }));
    const destination = policy.resolveDestination('https://unknown-malicious-host.com/api');
    assert.equal(destination.allowed, false);
  });

  it('should allow callApi to Telegram API host in test mode', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'test' }));
    const destination = policy.resolveDestination('https://api.telegram.org/bot/test/sendMessage');
    assert.equal(destination.allowed, true);
  });

  it('should enforce daily message ceiling via rate limiter', () => {
    const policy = new EgressPolicy(testConfig({
      rateLimitDefaults: { ...testConfig().rateLimitDefaults, dailyMessageCeiling: 1 },
    }));
    assert.equal(policy.getRateLimiter().checkDaily('telegram:test'), true);
    assert.equal(policy.getRateLimiter().checkDaily('telegram:test'), false);
  });
});

describe('Egress integration — adminTelegramFetch', () => {
  it('should deny admin Telegram fetch to blocked destination', async () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const client = new EgressHttpClient(policy, testConfig().httpDefaults);
    await assert.rejects(
      () => client.fetch('https://evil-malicious-host.com/bot/test/getMe', {
        actionType: 'telegram.sendMessage',
        correlationId: 'test-admin-blocked',
      }),
      /Egress denied/,
    );
  });
});

describe('Egress integration — AI agent fetch', () => {
  it('should deny AI fetch to blocked destination', async () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const client = new EgressHttpClient(policy, testConfig().httpDefaults);
    await assert.rejects(
      () => client.fetch('https://evil-malicious-host.com/chat/completions', {
        actionType: 'ai.completion',
        destinationType: 'ai_provider',
        payloadClassification: 'internal_non_sensitive',
        correlationId: 'test-ai-blocked',
      }),
      /Egress denied/,
    );
  });
});

describe('Egress integration — no PII in diagnostics', () => {
  it('should not expose raw IDs in audit events', () => {
    const policy = new EgressPolicy(testConfig());
    const event = policy.createAuditEvent({
      actionType: 'telegram.sendMessage',
      destinationFingerprint: 'https://api.telegram.org',
      policyDecision: 'allowed',
      actorId: 'raw-telegram-id-12345',
      applicantId: 'raw-applicant-uuid',
      correlationId: 'test-pii',
    });
    assert.notEqual(event.actorId, 'raw-telegram-id-12345');
    assert.notEqual(event.applicantId, 'raw-applicant-uuid');
    assert.match(event.actorId!, /^[0-9a-f]{16}$/);
    assert.match(event.applicantId!, /^[0-9a-f]{16}$/);
  });

  it('should not contain message bodies in audit events', () => {
    const policy = new EgressPolicy(testConfig());
    const event = policy.createAuditEvent({
      actionType: 'telegram.sendMessage',
      destinationFingerprint: 'https://api.telegram.org',
      policyDecision: 'allowed',
      correlationId: 'test-no-body',
    });
    assert.equal(Object.keys(event).includes('body'), false);
    assert.equal(Object.keys(event).includes('content'), false);
    assert.equal(Object.keys(event).includes('text'), false);
  });
});

describe('Egress integration — no staging-to-production fallback', () => {
  it('should block production destination from staging', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'staging' }));
    const result = policy.resolveDestination('https://production-webhook.academy.com/hook');
    assert.equal(result.allowed, false);
  });

  it('should block staging destination from production', () => {
    const policy = new EgressPolicy(testConfig({ environment: 'production' }));
    const result = policy.resolveDestination('https://webhook.site/test');
    assert.equal(result.allowed, false);
  });
});

describe('Egress integration — rate limit enforcement', () => {
  it('should enforce per-destination rate limit', () => {
    const policy = new EgressPolicy(testConfig({
      rateLimitDefaults: { ...testConfig().rateLimitDefaults, perDestinationMax: 2 },
    }));
    const limiter = policy.getRateLimiter();
    assert.equal(limiter.check('test-dest'), true);
    assert.equal(limiter.check('test-dest'), true);
    assert.equal(limiter.check('test-dest'), false);
  });

  it('should allow different destinations independently', () => {
    const policy = new EgressPolicy(testConfig({
      rateLimitDefaults: { ...testConfig().rateLimitDefaults, perDestinationMax: 1 },
    }));
    const limiter = policy.getRateLimiter();
    assert.equal(limiter.check('dest-a'), true);
    assert.equal(limiter.check('dest-b'), true);
    assert.equal(limiter.check('dest-a'), false);
    assert.equal(limiter.check('dest-b'), false);
  });
});
