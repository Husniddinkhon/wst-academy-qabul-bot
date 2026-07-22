import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authorizationCallbackSecret,
  isSafeAuthorizationAudit,
  JsonAuthorizationStore,
  migrateAuthorizationDatabase,
  roleAssignmentPayload,
  roleRevocationPayload,
  rollbackAuthorizationDatabase,
  type ResourceScope,
  type Role,
} from '../src/authorization.js';

const NOW = new Date('2026-07-22T10:00:00.000Z');
const OWNER_1 = 910_000_001;
const OWNER_2 = 910_000_002;
const OWNER_3 = 910_000_003;
const ALL: ResourceScope[] = [{ kind: '*', mode: 'all' }];
const actor = (id?: number, chatId = id, chatType = 'private') => ({ telegramUserId: id, telegramChatId: chatId, chatType });

async function fixture(owners = [OWNER_1, OWNER_2, OWNER_3]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'authorization-'));
  const file = path.join(directory, 'authorization.json');
  const store = new JsonAuthorizationStore(file, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
  await store.bootstrapOwners(owners, NOW);
  return { directory, file, store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function assignRole(store: JsonAuthorizationStore, target: number, role: Role, scopes: ResourceScope[] = ALL, maker = OWNER_1, approver = OWNER_2, reason = 'Approved synthetic role assignment.') {
  const resource = { kind: 'role' as const, id: String(target) };
  const payload = roleAssignmentPayload(target, role, scopes, reason);
  const request = await store.requestApproval(actor(maker), 'role.assign', resource, payload, 'v1', new Date(NOW.getTime() + 60_000), 'request-role', NOW);
  assert.equal(request.ok, true);
  if (!request.ok) throw new Error('Role request failed.');
  assert.equal((await store.approveRequest(request.approval.approvalId, actor(approver), payload, 'v1', 'approve-role', NOW)).ok, true);
  const assigned = await store.assignRole(request.approval.approvalId, actor(maker), target, role, scopes, reason, 'v1', 'assign-role', undefined, NOW);
  assert.equal(assigned.ok, true);
  if (!assigned.ok) throw new Error('Role assignment failed.');
  return assigned.assignment;
}

async function requestPublication(store: JsonAuthorizationStore, maker = OWNER_1, payload: unknown = { post: 'immutable' }) {
  const resource = { kind: 'publication' as const, id: 'post-1', channel: 'staging-channel' };
  const request = await store.requestApproval(actor(maker), 'publication.publish', resource, payload, 'v1', new Date(NOW.getTime() + 60_000), 'publication-request', NOW);
  assert.equal(request.ok, true);
  if (!request.ok) throw new Error('Publication request failed.');
  return { resource, payload, approval: request.approval };
}

test('unauthenticated, inactive, permission-missing and scope-missing actors fail closed', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.store.authorize(actor(undefined), 'applicant.view.masked', { kind: 'applicant', id: 'app-1' }, 'anonymous', NOW)).reason, 'unauthenticated');
    assert.equal((await f.store.authorize(actor(999_000_001), 'applicant.view.masked', { kind: 'applicant', id: 'app-1' }, 'unknown', NOW)).reason, 'inactive');
    const assignment = await assignRole(f.store, 920_000_001, 'ADMISSIONS_OPERATOR', [{ kind: 'applicant', mode: 'assigned', resourceIds: ['app-1'] }]);
    const restartedAssigned = new JsonAuthorizationStore(f.file, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    assert.equal((await restartedAssigned.authorize(actor(920_000_001), 'applicant.view.masked', { kind: 'applicant', id: 'app-1' }, 'assigned-after-restart', NOW)).ok, true);
    assert.equal((await f.store.authorize(actor(920_000_001), 'applicant.export', { kind: 'applicant', id: 'app-1' }, 'missing-permission', NOW)).reason, 'permission_missing');
    assert.equal((await f.store.authorize(actor(920_000_001), 'applicant.update', { kind: 'applicant', id: 'app-2' }, 'missing-scope', NOW)).reason, 'scope_missing');
    const revokePayload = roleRevocationPayload(assignment.assignmentId, 'Synthetic role revocation.');
    const revokeRequest = await f.store.requestApproval(actor(OWNER_1), 'role.revoke', { kind: 'role', id: assignment.assignmentId }, revokePayload, 'v1', new Date(NOW.getTime() + 60_000), 'revoke-request', NOW);
    assert.equal(revokeRequest.ok, true);
    if (!revokeRequest.ok) return;
    await f.store.approveRequest(revokeRequest.approval.approvalId, actor(OWNER_2), revokePayload, 'v1', 'revoke-approve', NOW);
    assert.equal((await f.store.revokeRole(revokeRequest.approval.approvalId, actor(OWNER_1), assignment.assignmentId, 'Synthetic role revocation.', 'v1', 'revoke-execute', NOW)).ok, true);
    const restartedRevoked = new JsonAuthorizationStore(f.file, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    assert.equal((await restartedRevoked.authorize(actor(920_000_001), 'applicant.view.masked', { kind: 'applicant', id: 'app-1' }, 'revoked-next-command', NOW)).reason, 'inactive');
  } finally { await f.cleanup(); }
});

test('masked access is distinct from sensitive view and operators cannot export', async () => {
  const f = await fixture();
  try {
    await assignRole(f.store, 920_000_002, 'ADMISSIONS_OPERATOR', [{ kind: 'applicant', mode: 'assigned', resourceIds: ['app-1'] }]);
    assert.equal((await f.store.authorize(actor(920_000_002), 'applicant.view.masked', { kind: 'applicant', id: 'app-1' }, 'masked', NOW)).ok, true);
    assert.equal((await f.store.authorize(actor(920_000_002), 'applicant.view.sensitive', { kind: 'applicant', id: 'app-1' }, 'sensitive', NOW)).reason, 'permission_missing');
    assert.equal((await f.store.authorize(actor(920_000_002), 'applicant.export', { kind: 'applicant', id: 'app-1' }, 'export', NOW)).reason, 'permission_missing');
    await assignRole(f.store, 920_000_005, 'ADMISSIONS_MANAGER', [{ kind: 'applicant', mode: 'assigned', resourceIds: ['app-1'] }]);
    assert.equal((await f.store.authorize(actor(920_000_005), 'applicant.view.sensitive', { kind: 'applicant', id: 'app-1' }, 'sensitive-scoped', NOW, 'Synthetic review purpose.')).ok, true);
    assert.equal((await f.store.authorize(actor(920_000_005), 'applicant.view.sensitive', { kind: 'applicant', id: 'app-2' }, 'sensitive-out-of-scope', NOW, 'Synthetic review purpose.')).reason, 'scope_missing');
  } finally { await f.cleanup(); }
});

test('program, region, channel, campaign and audit-only scopes are enforced', async () => {
  const f = await fixture();
  try {
    await assignRole(f.store, 920_000_010, 'ADMISSIONS_OPERATOR', [{ kind: 'applicant', mode: 'selected', programs: ['cctv'], regions: ['tashkent'] }]);
    assert.equal((await f.store.authorize(actor(920_000_010), 'applicant.update', { kind: 'applicant', id: 'app-1', program: 'cctv', region: 'tashkent' }, 'matching-program-region', NOW)).ok, true);
    assert.equal((await f.store.authorize(actor(920_000_010), 'applicant.update', { kind: 'applicant', id: 'app-1', program: 'access-control', region: 'tashkent' }, 'wrong-program', NOW)).reason, 'scope_missing');
    assert.equal((await f.store.authorize(actor(920_000_010), 'applicant.update', { kind: 'applicant', id: 'app-1', program: 'cctv', region: 'samarkand' }, 'wrong-region', NOW)).reason, 'scope_missing');

    await assignRole(f.store, 920_000_011, 'PUBLISHER', [{ kind: 'publication', mode: 'selected', channels: ['staging-channel'] }]);
    assert.equal((await f.store.authorize(actor(920_000_011), 'publication.create', { kind: 'publication', id: 'post-1', channel: 'staging-channel' }, 'matching-channel', NOW)).ok, true);
    assert.equal((await f.store.authorize(actor(920_000_011), 'publication.create', { kind: 'publication', id: 'post-1', channel: 'other-channel' }, 'wrong-channel', NOW)).reason, 'scope_missing');

    await assignRole(f.store, 920_000_012, 'FOLLOWUP_OPERATOR', [{ kind: 'followup', mode: 'selected', campaigns: ['welcome'] }]);
    assert.equal((await f.store.authorize(actor(920_000_012), 'followup.send', { kind: 'followup', campaign: 'welcome' }, 'matching-campaign', NOW)).ok, true);
    assert.equal((await f.store.authorize(actor(920_000_012), 'followup.send', { kind: 'followup', campaign: 'marketing' }, 'wrong-campaign', NOW)).reason, 'scope_missing');

    await assignRole(f.store, 920_000_013, 'AUDITOR', [{ kind: '*', mode: 'audit_only' }]);
    assert.equal((await f.store.authorize(actor(920_000_013), 'system.audit.view', { kind: 'system' }, 'audit-only', NOW)).ok, true);
    assert.equal((await f.store.authorize(actor(920_000_013), 'applicant.update', { kind: 'applicant', id: 'app-1' }, 'audit-write-denied', NOW)).reason, 'permission_missing');
  } finally { await f.cleanup(); }
});

test('maker and owner cannot self-approve, and wrong approver permission is denied', async () => {
  const f = await fixture();
  try {
    const publication = await requestPublication(f.store);
    assert.equal((await f.store.approveRequest(publication.approval.approvalId, actor(OWNER_1), publication.payload, 'v1', 'self-approve', NOW)).reason, 'self_approval');
    assert.equal((await f.store.approveStoredRequest(publication.approval.approvalId, actor(OWNER_1), 'self-approve-stored', NOW)).reason, 'self_approval');
    await assignRole(f.store, 920_000_003, 'SUPPORT_READONLY', [{ kind: 'applicant', mode: 'all' }]);
    assert.equal((await f.store.approveRequest(publication.approval.approvalId, actor(920_000_003), publication.payload, 'v1', 'wrong-approver', NOW)).reason, 'permission_missing');
    assert.equal((await f.store.approveStoredRequest(publication.approval.approvalId, actor(OWNER_2), 'approve-stored', NOW)).ok, true);
    assert.equal((await f.store.consumeApproval(publication.approval.approvalId, actor(OWNER_1), 'publication.publish', publication.resource, publication.payload, 'v1', 'consume-stored', NOW)).ok, true);
  } finally { await f.cleanup(); }
});

test('approval binds payload, version, expiry, revocation and one-time consumption', async () => {
  const f = await fixture();
  try {
    const first = await requestPublication(f.store);
    assert.equal((await f.store.approveRequest(first.approval.approvalId, actor(OWNER_2), { post: 'changed' }, 'v1', 'payload-change', NOW)).reason, 'payload_mismatch');
    assert.equal((await f.store.approveRequest(first.approval.approvalId, actor(OWNER_2), first.payload, 'v2', 'version-change', NOW)).reason, 'version_mismatch');
    assert.equal((await f.store.approveRequest(first.approval.approvalId, actor(OWNER_2), first.payload, 'v1', 'approved', NOW)).ok, true);
    assert.equal((await f.store.consumeApproval(first.approval.approvalId, actor(OWNER_1), 'publication.publish', first.resource, first.payload, 'v1', 'consume', NOW)).ok, true);
    const restartedConsumed = new JsonAuthorizationStore(f.file, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    assert.equal((await restartedConsumed.consumeApproval(first.approval.approvalId, actor(OWNER_1), 'publication.publish', first.resource, first.payload, 'v1', 'reuse-after-restart', NOW)).reason, 'reused');

    const expiredPayload = { post: 'expires' };
    const expired = await f.store.requestApproval(actor(OWNER_1), 'publication.publish', first.resource, expiredPayload, 'v1', new Date(NOW.getTime() + 1_000), 'expires', NOW);
    assert.equal(expired.ok, true);
    if (expired.ok) assert.equal((await f.store.approveRequest(expired.approval.approvalId, actor(OWNER_2), expiredPayload, 'v1', 'expired', new Date(NOW.getTime() + 1_001))).reason, 'expired');

    const revoked = await requestPublication(f.store, OWNER_2, { post: 'revoked' });
    assert.equal((await f.store.revokeRequest(revoked.approval.approvalId, actor(OWNER_2), 'revoke-approval', NOW)).ok, true);
    assert.equal((await f.store.consumeApproval(revoked.approval.approvalId, actor(OWNER_2), 'publication.publish', revoked.resource, revoked.payload, 'v1', 'consume-revoked', NOW)).reason, 'revoked');
  } finally { await f.cleanup(); }
});

test('self-assignment, self-elevation and last OWNER removal are denied', async () => {
  const f = await fixture([OWNER_1]);
  try {
    const ownerAssignment = (await f.store.assignments()).find((item) => item.role === 'OWNER')!;
    const samePayload = roleAssignmentPayload(OWNER_1, 'OWNER', ALL, 'Synthetic self assignment.');
    const sameRequest = await f.store.requestApproval(actor(OWNER_1), 'role.assign', { kind: 'role', id: String(OWNER_1) }, samePayload, 'v1', new Date(NOW.getTime() + 60_000), 'same-request', NOW);
    assert.equal(sameRequest.ok, true);
    if (sameRequest.ok) assert.equal((await f.store.assignRole(sameRequest.approval.approvalId, actor(OWNER_1), OWNER_1, 'OWNER', ALL, 'Synthetic self assignment.', 'v1', 'same-execute', undefined, NOW)).reason, 'self_assignment');
    const elevationPayload = roleAssignmentPayload(OWNER_1, 'PUBLISHER', ALL, 'Synthetic self elevation.');
    const elevationRequest = await f.store.requestApproval(actor(OWNER_1), 'role.assign', { kind: 'role', id: String(OWNER_1) }, elevationPayload, 'v1', new Date(NOW.getTime() + 60_000), 'elevation-request', NOW);
    assert.equal(elevationRequest.ok, true);
    if (elevationRequest.ok) assert.equal((await f.store.assignRole(elevationRequest.approval.approvalId, actor(OWNER_1), OWNER_1, 'PUBLISHER', ALL, 'Synthetic self elevation.', 'v1', 'elevation-execute', undefined, NOW)).reason, 'self_elevation');
    assert.equal((await f.store.revokeRole('missing-approval', actor(OWNER_1), ownerAssignment.assignmentId, 'Synthetic owner removal.', 'v1', 'last-owner', NOW)).reason, 'last_owner');
  } finally { await f.cleanup(); }
});

test('a maker cannot bypass self-elevation or self-revocation through a different executor', async () => {
  const f = await fixture();
  try {
    const elevationPayload = roleAssignmentPayload(OWNER_1, 'PUBLISHER', ALL, 'Cross executor self elevation.');
    const elevation = await f.store.requestApproval(actor(OWNER_1), 'role.assign', { kind: 'role', id: String(OWNER_1) }, elevationPayload, 'v1', new Date(NOW.getTime() + 60_000), 'cross-elevation', NOW);
    assert.equal(elevation.ok, true);
    if (!elevation.ok) return;
    assert.equal((await f.store.approveRequest(elevation.approval.approvalId, actor(OWNER_2), elevationPayload, 'v1', 'cross-elevation-approve', NOW)).ok, true);
    assert.equal((await f.store.assignRole(elevation.approval.approvalId, actor(OWNER_2), OWNER_1, 'PUBLISHER', ALL, 'Cross executor self elevation.', 'v1', 'cross-elevation-execute', undefined, NOW)).reason, 'self_elevation');

    const ownerActorId = (await f.store.actors()).find((candidate) => candidate.telegramUserId === OWNER_1)?.actorId;
    const ownerAssignment = (await f.store.assignments()).find((item) => item.role === 'OWNER' && item.actorId === ownerActorId)!;
    const revocationPayload = roleRevocationPayload(ownerAssignment.assignmentId, 'Cross executor self revocation.');
    const revocation = await f.store.requestApproval(actor(OWNER_1), 'role.revoke', { kind: 'role', id: ownerAssignment.assignmentId }, revocationPayload, 'v1', new Date(NOW.getTime() + 60_000), 'cross-revocation', NOW);
    assert.equal(revocation.ok, true);
    if (!revocation.ok) return;
    assert.equal((await f.store.approveRequest(revocation.approval.approvalId, actor(OWNER_2), revocationPayload, 'v1', 'cross-revocation-approve', NOW)).ok, true);
    assert.equal((await f.store.revokeRole(revocation.approval.approvalId, actor(OWNER_2), ownerAssignment.assignmentId, 'Cross executor self revocation.', 'v1', 'cross-revocation-execute', NOW)).reason, 'self_revocation');
    assert.ok((await f.store.audit()).some((event) => event.decision === 'DENY' && event.action.includes('self_')));
  } finally { await f.cleanup(); }
});

test('signed callbacks reject forged actor, expiry and replay while reauthorizing execution', async () => {
  const f = await fixture();
  try {
    const created = await f.store.createSignedCallback(actor(OWNER_1), 'publication.publish', 'publish', { kind: 'publication', id: 'post-1' }, new Date(NOW.getTime() + 60_000), 'callback-create', NOW);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const forgedPayload = `${created.payload.slice(0, -1)}${created.payload.endsWith('0') ? '1' : '0'}`;
    assert.equal((await f.store.consumeSignedCallback(forgedPayload, actor(OWNER_1), 'forged', NOW)).reason, 'forged');
    assert.equal((await f.store.consumeSignedCallback(created.payload, actor(OWNER_2), 'wrong-actor', NOW)).reason, 'actor_mismatch');
    assert.equal((await f.store.consumeSignedCallback(created.payload, actor(OWNER_1), 'consume', NOW)).ok, true);
    const restarted = new JsonAuthorizationStore(f.file, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    assert.equal((await restarted.consumeSignedCallback(created.payload, actor(OWNER_1), 'replay-after-restart', NOW)).reason, 'replayed');
    const expiring = await f.store.createSignedCallback(actor(OWNER_1), 'publication.publish', 'publish', { kind: 'publication', id: 'post-2' }, new Date(NOW.getTime() + 1_000), 'callback-expiring', NOW);
    assert.equal(expiring.ok, true);
    if (expiring.ok) assert.equal((await f.store.consumeSignedCallback(expiring.payload, actor(OWNER_1), 'expired', new Date(NOW.getTime() + 1_001))).reason, 'expired');
  } finally { await f.cleanup(); }
});

test('concurrent approval and role updates serialize without duplicate authority', async () => {
  const f = await fixture();
  try {
    const publication = await requestPublication(f.store);
    const approvals = await Promise.all([
      f.store.approveRequest(publication.approval.approvalId, actor(OWNER_2), publication.payload, 'v1', 'approve-a', NOW),
      f.store.approveRequest(publication.approval.approvalId, actor(OWNER_3), publication.payload, 'v1', 'approve-b', NOW),
    ]);
    assert.equal(approvals.filter((result) => result.ok).length, 1);
    const consumptions = await Promise.all([
      f.store.consumeApproval(publication.approval.approvalId, actor(OWNER_1), 'publication.publish', publication.resource, publication.payload, 'v1', 'consume-a', NOW),
      f.store.consumeApproval(publication.approval.approvalId, actor(OWNER_1), 'publication.publish', publication.resource, publication.payload, 'v1', 'consume-b', NOW),
    ]);
    assert.equal(consumptions.filter((result) => result.ok).length, 1);

    const target = 920_000_004;
    const resource = { kind: 'role' as const, id: String(target) };
    const leftPayload = roleAssignmentPayload(target, 'SUPPORT_READONLY', [{ kind: 'applicant', mode: 'all' }], 'Concurrent role update alpha.');
    const rightPayload = roleAssignmentPayload(target, 'SUPPORT_READONLY', [{ kind: 'applicant', mode: 'all' }], 'Concurrent role update beta.');
    const left = await f.store.requestApproval(actor(OWNER_1), 'role.assign', resource, leftPayload, 'v1', new Date(NOW.getTime() + 60_000), 'role-left', NOW);
    const right = await f.store.requestApproval(actor(OWNER_2), 'role.assign', resource, rightPayload, 'v1', new Date(NOW.getTime() + 60_000), 'role-right', NOW);
    assert.equal(left.ok && right.ok, true);
    if (!left.ok || !right.ok) return;
    await f.store.approveRequest(left.approval.approvalId, actor(OWNER_2), leftPayload, 'v1', 'role-left-approve', NOW);
    await f.store.approveRequest(right.approval.approvalId, actor(OWNER_3), rightPayload, 'v1', 'role-right-approve', NOW);
    const updates = await Promise.all([
      f.store.assignRole(left.approval.approvalId, actor(OWNER_1), target, 'SUPPORT_READONLY', [{ kind: 'applicant', mode: 'all' }], 'Concurrent role update alpha.', 'v1', 'role-left-execute', undefined, NOW),
      f.store.assignRole(right.approval.approvalId, actor(OWNER_2), target, 'SUPPORT_READONLY', [{ kind: 'applicant', mode: 'all' }], 'Concurrent role update beta.', 'v1', 'role-right-execute', undefined, NOW),
    ]);
    assert.equal(updates.filter((result) => result.ok).length, 1);
    assert.equal((await f.store.assignments()).filter((item) => item.role === 'SUPPORT_READONLY' && item.state === 'ACTIVE').length, 1);
  } finally { await f.cleanup(); }
});

test('restart, migration, rollback and audit redaction remain durable and fail closed', async () => {
  const f = await fixture();
  try {
    await f.store.authorize(actor(OWNER_1), 'applicant.view.sensitive', { kind: 'applicant', id: 'app-1' }, 'private free text +998000000001 BOT_TOKEN', NOW, 'Reviewed admissions case.');
    const historicalAudit = await f.store.audit();
    const historicalEvent = historicalAudit[0];
    const restarted = new JsonAuthorizationStore(f.file, authorizationCallbackSecret('synthetic-test-bot-token-with-safe-length'));
    assert.equal((await restarted.authorize(actor(OWNER_1), 'role.view', { kind: 'role' }, 'restart', NOW)).ok, true);
    const reloadedHistoricalEvent = (await restarted.audit()).find((event) => event.eventId === historicalEvent.eventId);
    assert.equal(reloadedHistoricalEvent?.correlationId, historicalEvent.correlationId);
    assert.ok((await restarted.audit()).every(isSafeAuthorizationAudit));
    assert.doesNotMatch(JSON.stringify(await restarted.audit()), /\+998000000001|BOT_TOKEN|private free text|Reviewed admissions case/);
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    const rollback = rollbackAuthorizationDatabase(migrateAuthorizationDatabase(saved));
    assert.equal(migrateAuthorizationDatabase(rollback).schemaVersion, 1);
    assert.throws(() => migrateAuthorizationDatabase({ schemaVersion: 2 } as never), /Unsupported/);
    const conflicted = migrateAuthorizationDatabase({ actors: [saved.actors[0], { ...saved.actors[0], actorId: 'duplicate' }] });
    assert.ok(conflicted.actors.every((item) => item.status === 'REVOKED'));
    const malformed = migrateAuthorizationDatabase({
      actors: [saved.actors[0]],
      assignments: [{ ...saved.assignments[0], role: 'UNKNOWN_ROLE' }],
      approvals: [{ ...saved.approvals?.[0], action: 'unknown.action' }],
      callbacks: [{ callbackId: 'invalid', permission: 'role.assign' }],
    } as never);
    assert.equal(malformed.assignments[0]?.state, 'REVOKED');
    assert.equal(malformed.approvals.length, 0);
    assert.equal(malformed.callbacks.length, 0);
    await writeFile(path.join(f.directory, 'rollback.json'), JSON.stringify(rollback), 'utf8');
  } finally { await f.cleanup(); }
});

test('legacy flat admin check is not an authorization path', async () => {
  const source = await readFile(path.join(process.cwd(), 'src', 'admin.ts'), 'utf8');
  assert.doesNotMatch(source, /function isAdmin|adminIds\.includes|const guard = .*isAdmin/);
  const indexSource = await readFile(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');
  assert.deepEqual(indexSource.match(/config\.adminIds/g), ['config.adminIds']);
  assert.match(indexSource, /authorization\.bootstrapOwners\(config\.adminIds\)/);
});
