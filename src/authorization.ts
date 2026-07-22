import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicWriteJson, readJson, withFileLock } from './safeJson.js';
import { backupStoreFile, restoreStoreFile, MigrationRequiredError } from './migrationEngine.js';

export const AUTHORIZATION_SCHEMA_VERSION = 1;

export const PERMISSIONS = [
  'applicant.view.masked', 'applicant.view.sensitive', 'applicant.review', 'applicant.update', 'applicant.block',
  'applicant.merge.request', 'applicant.merge.approve', 'applicant.consent.view', 'applicant.audit.view', 'applicant.export',
  'publication.create', 'publication.approve', 'publication.publish', 'publication.reconcile',
  'followup.create', 'followup.approve', 'followup.send', 'followup.cancel',
  'webhook.replay', 'deadletter.view', 'deadletter.replay',
  'role.view', 'role.assign', 'role.revoke', 'system.audit.view',
] as const;
export type Permission = typeof PERMISSIONS[number];

export const ROLES = ['OWNER', 'ADMISSIONS_MANAGER', 'ADMISSIONS_OPERATOR', 'REVIEWER', 'PUBLISHER', 'FOLLOWUP_OPERATOR', 'AUDITOR', 'SUPPORT_READONLY'] as const;
export type Role = typeof ROLES[number];
export type ResourceKind = 'applicant' | 'publication' | 'followup' | 'webhook' | 'role' | 'system';
export type ScopeMode = 'all' | 'assigned' | 'selected' | 'audit_only';

export interface ResourceScope {
  kind: ResourceKind | '*';
  mode: ScopeMode;
  resourceIds?: string[];
  programs?: string[];
  regions?: string[];
  channels?: string[];
  campaigns?: string[];
}

export interface ResourceRef {
  kind: ResourceKind;
  id?: string;
  program?: string;
  region?: string;
  channel?: string;
  campaign?: string;
}

export interface AuthorizationActorInput { telegramUserId?: unknown; telegramChatId?: unknown; chatType?: unknown }
export interface AuthorizationActor { actorId: string; telegramUserId: number; status: 'ACTIVE' | 'REVOKED'; createdAt: string; updatedAt: string; revokedAt?: string }
export interface RoleAssignment {
  assignmentId: string;
  actorId: string;
  role: Role;
  state: 'ACTIVE' | 'REVOKED';
  scopes: ResourceScope[];
  effectiveAt: string;
  expiresAt?: string;
  reason: string;
  assignedBy: string;
  approvedBy?: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

export type ApprovalAction = 'applicant.merge' | 'applicant.export' | 'applicant.block' | 'publication.approve' | 'publication.publish' | 'publication.reconcile' | 'followup.send' | 'deadletter.replay' | 'role.assign' | 'role.revoke';
export type ApprovalState = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED' | 'CONSUMED' | 'EXPIRED';
export interface ApprovalRequest {
  approvalId: string;
  action: ApprovalAction;
  resource: ResourceRef;
  resourceDigest: string;
  requestDigest: string;
  summary: string[];
  version: string;
  makerActorId: string;
  approverActorId?: string;
  state: ApprovalState;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface AuthorizationAuditEvent {
  eventId: string;
  actorId: string;
  roles: Role[];
  permission?: Permission;
  scope: string[];
  action: string;
  makerActorId?: string;
  approverActorId?: string;
  approvalId?: string;
  approvalVersion?: string;
  requestDigest?: string;
  decision: 'ALLOW' | 'DENY' | 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REVOKED' | 'CONSUMED';
  timestamp: string;
  correlationId: string;
}

interface CallbackIntent {
  callbackId: string;
  actorId: string;
  permission: Permission;
  action: string;
  resource: ResourceRef;
  expiresAt: string;
  state: 'ACTIVE' | 'CONSUMED';
  createdAt: string;
  consumedAt?: string;
}

interface AuthorizationDatabase {
  schemaVersion: 1;
  actors: AuthorizationActor[];
  assignments: RoleAssignment[];
  approvals: ApprovalRequest[];
  callbacks: CallbackIntent[];
  audit: AuthorizationAuditEvent[];
  denialBuckets: Array<{ key: string; at: string }>;
}
interface LegacyAuthorizationDatabase extends Partial<Omit<AuthorizationDatabase, 'schemaVersion'>> { schemaVersion?: 0 | 1 }

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMISSIONS_MANAGER: ['applicant.view.masked', 'applicant.view.sensitive', 'applicant.review', 'applicant.update', 'applicant.block', 'applicant.merge.request', 'applicant.merge.approve', 'applicant.consent.view', 'applicant.audit.view', 'applicant.export', 'followup.create', 'followup.approve', 'followup.cancel', 'role.view'],
  ADMISSIONS_OPERATOR: ['applicant.view.masked', 'applicant.update', 'applicant.consent.view', 'followup.create', 'followup.cancel'],
  REVIEWER: ['applicant.view.masked', 'applicant.view.sensitive', 'applicant.review', 'applicant.merge.approve', 'applicant.audit.view', 'publication.approve', 'followup.approve', 'deadletter.view', 'deadletter.replay', 'system.audit.view'],
  PUBLISHER: ['publication.create', 'publication.approve', 'publication.publish', 'publication.reconcile'],
  FOLLOWUP_OPERATOR: ['applicant.view.masked', 'followup.create', 'followup.send', 'followup.cancel'],
  AUDITOR: ['applicant.view.masked', 'applicant.consent.view', 'applicant.audit.view', 'deadletter.view', 'role.view', 'system.audit.view'],
  SUPPORT_READONLY: ['applicant.view.masked'],
};

const APPROVAL_POLICIES: Record<ApprovalAction, { maker: Permission; approver: Permission; executor: Permission }> = {
  'applicant.merge': { maker: 'applicant.merge.request', approver: 'applicant.merge.approve', executor: 'applicant.merge.approve' },
  'applicant.export': { maker: 'applicant.export', approver: 'applicant.export', executor: 'applicant.export' },
  'applicant.block': { maker: 'applicant.block', approver: 'applicant.review', executor: 'applicant.block' },
  'publication.approve': { maker: 'publication.create', approver: 'publication.approve', executor: 'publication.approve' },
  'publication.publish': { maker: 'publication.create', approver: 'publication.approve', executor: 'publication.publish' },
  'publication.reconcile': { maker: 'publication.reconcile', approver: 'publication.approve', executor: 'publication.reconcile' },
  'followup.send': { maker: 'followup.create', approver: 'followup.approve', executor: 'followup.send' },
  'deadletter.replay': { maker: 'deadletter.replay', approver: 'deadletter.replay', executor: 'deadletter.replay' },
  'role.assign': { maker: 'role.assign', approver: 'role.assign', executor: 'role.assign' },
  'role.revoke': { maker: 'role.revoke', approver: 'role.revoke', executor: 'role.revoke' },
};

export type AuthorizationDecision =
  | { ok: true; actor: AuthorizationActor; roles: Role[]; permission: Permission; scopes: ResourceScope[] }
  | { ok: false; reason: 'unauthenticated' | 'inactive' | 'permission_missing' | 'scope_missing' };
export type ApprovalResult =
  | { ok: true; approval: ApprovalRequest; status: 'requested' | 'pending' | 'approved' | 'consumed' }
  | { ok: false; reason: ApprovalFailureReason };
type ApprovalFailureReason = 'unauthenticated' | 'inactive' | 'permission_missing' | 'scope_missing' | 'not_found' | 'self_approval' | 'wrong_state' | 'expired' | 'payload_mismatch' | 'version_mismatch' | 'reused' | 'revoked';

const AUTHORIZATION_MIGRATION_DIR = 'data/migrations/authorization';

export class JsonAuthorizationStore {
  constructor(private readonly filePath: string, private readonly callbackSecret: string) {
    if (callbackSecret.length < 32) throw new Error('Authorization callback secret must contain at least 32 characters.');
  }

  async detectVersion(): Promise<number | null> {
    try {
      const raw = await readJson<Record<string, unknown>>(this.filePath, {});
      if (typeof raw?.schemaVersion === 'number') return raw.schemaVersion;
      if (raw && typeof raw === 'object' && 'actors' in raw && Array.isArray(raw.actors) && raw.actors.length > 0) return 0;
      return null;
    } catch {
      return null;
    }
  }

  async migrateStore(dryRun: boolean): Promise<{ backupHash: string; backupPath: string } | null> {
    const detected = await this.detectVersion();
    if (detected !== null && detected >= AUTHORIZATION_SCHEMA_VERSION) return null;
    if (detected === null) return null;
    const raw = await readJson<LegacyAuthorizationDatabase>(this.filePath, {});
    const backup = await backupStoreFile(this.filePath, AUTHORIZATION_MIGRATION_DIR, 'authorization');
    if (!dryRun) {
      const migrated = migrateAuthorizationDatabase(raw);
      await atomicWriteJson(this.filePath, migrated);
    }
    return { backupHash: backup.contentHash, backupPath: backup.backupPath };
  }

  async rollbackStore(backupPath: string): Promise<void> {
    await restoreStoreFile(backupPath, this.filePath);
  }

  async verifyStore(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const detected = await this.detectVersion();
    if (detected === null) {
      errors.push('No authorization data found.');
      return { ok: true, errors };
    }
    if (detected !== AUTHORIZATION_SCHEMA_VERSION) {
      errors.push(`Expected version ${AUTHORIZATION_SCHEMA_VERSION}, found ${detected}.`);
      return { ok: false, errors };
    }
    try {
      const raw = await readJson<AuthorizationDatabase>(this.filePath, {} as AuthorizationDatabase);
      if (!raw.actors || !Array.isArray(raw.actors)) errors.push('actors is not an array.');
      if (!raw.assignments || !Array.isArray(raw.assignments)) errors.push('assignments is not an array.');
      if (!raw.approvals || !Array.isArray(raw.approvals)) errors.push('approvals is not an array.');
    } catch (error) {
      errors.push(`Read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: errors.length === 0, errors };
  }

  async bootstrapOwners(telegramUserIds: number[], now = new Date()): Promise<{ created: number }> {
    const unique = [...new Set(telegramUserIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      if (db.actors.length || db.assignments.length) return { created: 0 };
      const at = now.toISOString();
      for (const telegramUserId of unique) {
        const actor: AuthorizationActor = { actorId: randomUUID(), telegramUserId, status: 'ACTIVE', createdAt: at, updatedAt: at };
        db.actors.push(actor);
        db.assignments.push({ assignmentId: randomUUID(), actorId: actor.actorId, role: 'OWNER', state: 'ACTIVE', scopes: [{ kind: '*', mode: 'all' }], effectiveAt: at, reason: 'Initial durable authorization bootstrap.', assignedBy: 'system', approvedBy: 'system', createdAt: at });
        appendAudit(db, { actorId: 'system', roles: [], action: 'role.bootstrap.owner', makerActorId: 'system', approverActorId: 'system', decision: 'ALLOW', timestamp: at, correlationId: hash(`bootstrap:${telegramUserId}`), scope: ['*:all'] });
      }
      if (unique.length) await this.write(db);
      return { created: unique.length };
    });
  }

  async authorize(input: AuthorizationActorInput, permission: Permission, resource: ResourceRef, correlationId: string, now = new Date(), purpose?: string, action?: string): Promise<AuthorizationDecision> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const decision = authorizeInDatabase(db, input, permission, resource, now);
      auditDecision(db, input, decision, permission, resource, correlationId, now, purpose, action);
      await this.write(db);
      return decision;
    });
  }

  async recipients(permission: Permission, resource: ResourceRef, now = new Date()): Promise<number[]> {
    const db = await this.read();
    return db.actors.filter((actor) => actor.status === 'ACTIVE' && hasAuthorization(db, actor, permission, resource, now).ok).map((actor) => actor.telegramUserId);
  }

  async authorizeCollection(input: AuthorizationActorInput, permission: Permission, kind: ResourceKind, correlationId: string, now = new Date()): Promise<AuthorizationDecision> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const deny = async (reason: Extract<AuthorizationDecision, { ok: false }>['reason']): Promise<AuthorizationDecision> => { const decision = { ok: false, reason } as const; auditDecision(db, input, decision, permission, { kind }, correlationId, now); await this.write(db); return decision; };
      if (!validActorInput(input)) return deny('unauthenticated');
      const actor = db.actors.find((item) => item.telegramUserId === input.telegramUserId);
      if (!actor || actor.status !== 'ACTIVE') return deny('inactive');
      const assignments = db.assignments.filter((item) => item.actorId === actor.actorId && assignmentActive(item, now) && ROLE_PERMISSIONS[item.role].includes(permission));
      if (!assignments.length) return deny('permission_missing');
      const scopes = assignments.flatMap((item) => item.scopes).filter((scope) => (scope.kind === '*' || scope.kind === kind) && scope.mode !== 'audit_only');
      if (!scopes.length) return deny('scope_missing');
      const decision: AuthorizationDecision = { ok: true, actor, roles: [...new Set(assignments.map((item) => item.role))], permission, scopes };
      appendAudit(db, eventFor(actor, decision, `authorize.collection.${permission}`, correlationId, now, 'ALLOW'));
      await this.write(db);
      return decision;
    });
  }

  async filterAuthorizedApplicants<T extends { id: string; applicantId?: string; goal?: string; city?: string }>(input: AuthorizationActorInput, permission: Permission, applicants: T[], now = new Date()): Promise<T[]> {
    const db = await this.read();
    const actor = authenticateInDatabase(db, input);
    if (!actor) return [];
    return applicants.filter((item) => hasAuthorization(db, actor, permission, { kind: 'applicant', id: item.applicantId ?? item.id, program: item.goal, region: item.city }, now).ok);
  }

  async requestApproval(input: AuthorizationActorInput, action: ApprovalAction, resource: ResourceRef, payload: unknown, version: string, expiresAt: Date, correlationId: string, now = new Date()): Promise<ApprovalResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const policy = APPROVAL_POLICIES[action];
      const maker = authenticateInDatabase(db, input);
      if (!maker) { const reason = validActorInput(input) ? 'inactive' : 'unauthenticated'; appendApprovalDenial(db, input, `approval.request.${action}`, reason, correlationId, now); await this.write(db); return { ok: false, reason } as const; }
      const auth = hasAuthorization(db, maker, policy.maker, resource, now);
      if (!auth.ok) { appendApprovalDenial(db, input, `approval.request.${action}`, auth.reason, correlationId, now); await this.write(db); return { ok: false, reason: auth.reason } as const; }
      if (!validVersion(version) || expiresAt.getTime() <= now.getTime() || expiresAt.getTime() - now.getTime() > 86_400_000) { appendApprovalDenial(db, input, `approval.request.${action}`, 'expired', correlationId, now); await this.write(db); return { ok: false, reason: 'expired' } as const; }
      const requestDigest = digestRequest(action, resource, payload, version);
      const existing = db.approvals.find((item) => item.makerActorId === maker.actorId && item.requestDigest === requestDigest && ['PENDING', 'APPROVED'].includes(item.state));
      if (existing) return { ok: true, approval: existing, status: existing.state === 'APPROVED' ? 'approved' : 'pending' } as const;
      const approval: ApprovalRequest = { approvalId: randomUUID(), action, resource: normalizeResource(resource), resourceDigest: digestResource(resource), requestDigest, summary: summarizeApprovalPayload(payload), version, makerActorId: maker.actorId, state: 'PENDING', createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
      db.approvals.push(approval);
      appendAudit(db, eventFor(maker, auth, `approval.request.${action}`, correlationId, now, 'REQUESTED', approval));
      await this.write(db);
      return { ok: true, approval, status: 'requested' } as const;
    });
  }

  async approveRequest(approvalId: string, input: AuthorizationActorInput, payload: unknown, version: string, correlationId: string, now = new Date()): Promise<ApprovalResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const approval = db.approvals.find((item) => item.approvalId === approvalId);
      if (!approval) { appendApprovalDenial(db, input, 'approval.approve.unknown', 'not_found', correlationId, now); await this.write(db); return { ok: false, reason: 'not_found' } as const; }
      const approver = authenticateInDatabase(db, input);
      if (!approver) { const reason = validActorInput(input) ? 'inactive' : 'unauthenticated'; appendApprovalDenial(db, input, `approval.approve.${approval.action}`, reason, correlationId, now, approval); await this.write(db); return { ok: false, reason } as const; }
      if (approver.actorId === approval.makerActorId) { appendApprovalDenial(db, input, `approval.approve.${approval.action}`, 'self_approval', correlationId, now, approval); await this.write(db); return { ok: false, reason: 'self_approval' } as const; }
      const auth = hasAuthorization(db, approver, APPROVAL_POLICIES[approval.action].approver, approval.resource, now);
      if (!auth.ok) { appendApprovalDenial(db, input, `approval.approve.${approval.action}`, auth.reason, correlationId, now, approval); await this.write(db); return { ok: false, reason: auth.reason } as const; }
      const invalid = validateApprovalRequest(approval, payload, version, now);
      if (invalid) { appendApprovalDenial(db, input, `approval.approve.${approval.action}`, invalid, correlationId, now, approval); await this.write(db); return { ok: false, reason: invalid } as const; }
      if (approval.state !== 'PENDING') { const reason = approval.state === 'CONSUMED' ? 'reused' : approval.state === 'REVOKED' ? 'revoked' : 'wrong_state'; appendApprovalDenial(db, input, `approval.approve.${approval.action}`, reason, correlationId, now, approval); await this.write(db); return { ok: false, reason } as const; }
      approval.state = 'APPROVED'; approval.approverActorId = approver.actorId; approval.decidedAt = now.toISOString();
      appendAudit(db, eventFor(approver, auth, `approval.approve.${approval.action}`, correlationId, now, 'APPROVED', approval));
      await this.write(db);
      return { ok: true, approval, status: 'approved' } as const;
    });
  }

  async approveStoredRequest(approvalId: string, input: AuthorizationActorInput, correlationId: string, now = new Date()): Promise<ApprovalResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const approval = db.approvals.find((item) => item.approvalId === approvalId);
      if (!approval) { appendApprovalDenial(db, input, 'approval.approve.unknown', 'not_found', correlationId, now); await this.write(db); return { ok: false, reason: 'not_found' } as const; }
      const approver = authenticateInDatabase(db, input);
      if (!approver) { const reason = validActorInput(input) ? 'inactive' : 'unauthenticated'; appendApprovalDenial(db, input, `approval.approve.${approval.action}`, reason, correlationId, now, approval); await this.write(db); return { ok: false, reason } as const; }
      if (approver.actorId === approval.makerActorId) { appendApprovalDenial(db, input, `approval.approve.${approval.action}`, 'self_approval', correlationId, now, approval); await this.write(db); return { ok: false, reason: 'self_approval' } as const; }
      const auth = hasAuthorization(db, approver, APPROVAL_POLICIES[approval.action].approver, approval.resource, now);
      if (!auth.ok) { appendApprovalDenial(db, input, `approval.approve.${approval.action}`, auth.reason, correlationId, now, approval); await this.write(db); return { ok: false, reason: auth.reason } as const; }
      if (new Date(approval.expiresAt) <= now) {
        approval.state = 'EXPIRED';
        appendApprovalDenial(db, input, `approval.approve.${approval.action}`, 'expired', correlationId, now, approval);
        await this.write(db);
        return { ok: false, reason: 'expired' } as const;
      }
      if (approval.state !== 'PENDING') { const reason = approval.state === 'CONSUMED' ? 'reused' : approval.state === 'REVOKED' ? 'revoked' : 'wrong_state'; appendApprovalDenial(db, input, `approval.approve.${approval.action}`, reason, correlationId, now, approval); await this.write(db); return { ok: false, reason } as const; }
      approval.state = 'APPROVED';
      approval.approverActorId = approver.actorId;
      approval.decidedAt = now.toISOString();
      appendAudit(db, eventFor(approver, auth, `approval.approve.${approval.action}`, correlationId, now, 'APPROVED', approval));
      await this.write(db);
      return { ok: true, approval, status: 'approved' } as const;
    });
  }

  async rejectRequest(approvalId: string, input: AuthorizationActorInput, correlationId: string, now = new Date()): Promise<ApprovalResult> {
    return this.decideWithoutPayload(approvalId, input, 'REJECTED', correlationId, now);
  }

  async revokeRequest(approvalId: string, input: AuthorizationActorInput, correlationId: string, now = new Date()): Promise<ApprovalResult> {
    return this.decideWithoutPayload(approvalId, input, 'REVOKED', correlationId, now);
  }

  async consumeApproval(approvalId: string, input: AuthorizationActorInput, action: ApprovalAction, resource: ResourceRef, payload: unknown, version: string, correlationId: string, now = new Date()): Promise<ApprovalResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const result = consumeInDatabase(db, approvalId, input, action, resource, payload, version, correlationId, now);
      if (!result.ok) appendApprovalDenial(db, input, `approval.consume.${action}`, result.reason, correlationId, now, db.approvals.find((item) => item.approvalId === approvalId));
      await this.write(db);
      return result;
    });
  }

  async assignRole(approvalId: string, input: AuthorizationActorInput, targetTelegramUserId: number, role: Role, scopes: ResourceScope[], reason: string, version: string, correlationId: string, expiresAt: Date | undefined, now = new Date()): Promise<{ ok: true; assignment: RoleAssignment } | { ok: false; reason: string }> {
    const payload = rolePayload(targetTelegramUserId, role, scopes, reason, expiresAt);
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const approval = db.approvals.find((item) => item.approvalId === approvalId);
      const deny = async (denialReason: string) => { appendApprovalDenial(db, input, 'role.assign.execute', denialReason, correlationId, now, approval); await this.write(db); return { ok: false, reason: denialReason } as const; };
      const executor = authenticateInDatabase(db, input);
      if (!executor) return deny(validActorInput(input) ? 'inactive' : 'unauthenticated');
      const approvalMaker = db.actors.find((actor) => actor.actorId === approval?.makerActorId);
      if (executor.telegramUserId === targetTelegramUserId) {
        const alreadyHasRole = db.assignments.some((item) => item.actorId === executor.actorId && item.role === role && assignmentActive(item, now));
        return deny(alreadyHasRole ? 'self_assignment' : 'self_elevation');
      }
      if (approvalMaker?.telegramUserId === targetTelegramUserId) return deny('self_elevation');
      if (!Number.isSafeInteger(targetTelegramUserId) || targetTelegramUserId <= 0 || !ROLES.includes(role) || !validScopes(scopes) || reason.trim().length < 8) return deny('invalid_request');
      if (db.assignments.some((item) => item.actorId === db.actors.find((actor) => actor.telegramUserId === targetTelegramUserId)?.actorId && item.role === role && assignmentActive(item, now))) return deny('already_assigned');
      const consumed = consumeInDatabase(db, approvalId, input, 'role.assign', { kind: 'role', id: String(targetTelegramUserId) }, payload, version, correlationId, now);
      if (!consumed.ok) return deny(consumed.reason);
      let target = db.actors.find((actor) => actor.telegramUserId === targetTelegramUserId);
      const at = now.toISOString();
      if (!target) { target = { actorId: randomUUID(), telegramUserId: targetTelegramUserId, status: 'ACTIVE', createdAt: at, updatedAt: at }; db.actors.push(target); }
      if (target.status === 'REVOKED') { target.status = 'ACTIVE'; target.revokedAt = undefined; target.updatedAt = at; }
      const assignment: RoleAssignment = { assignmentId: randomUUID(), actorId: target.actorId, role, state: 'ACTIVE', scopes: normalizeScopes(scopes), effectiveAt: at, expiresAt: expiresAt?.toISOString(), reason: safeReason(reason), assignedBy: executor.actorId, approvedBy: consumed.approval.approverActorId, createdAt: at };
      db.assignments.push(assignment);
      appendAudit(db, { actorId: executor.actorId, roles: activeRoles(db, executor.actorId, now), permission: 'role.assign', scope: summarizeScopes(scopes), action: 'role.assign.execute', makerActorId: consumed.approval.makerActorId, approverActorId: consumed.approval.approverActorId, approvalId, approvalVersion: version, requestDigest: consumed.approval.requestDigest, decision: 'ALLOW', timestamp: at, correlationId: hash(correlationId) });
      await this.write(db);
      return { ok: true, assignment } as const;
    });
  }

  async revokeRole(approvalId: string, input: AuthorizationActorInput, assignmentId: string, reason: string, version: string, correlationId: string, now = new Date()): Promise<{ ok: true; assignment: RoleAssignment } | { ok: false; reason: string }> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const assignment = db.assignments.find((item) => item.assignmentId === assignmentId);
      const approval = db.approvals.find((item) => item.approvalId === approvalId);
      const deny = async (denialReason: string) => { appendApprovalDenial(db, input, 'role.revoke.execute', denialReason, correlationId, now, approval); await this.write(db); return { ok: false, reason: denialReason } as const; };
      const executor = authenticateInDatabase(db, input);
      if (!assignment || !executor) return deny(assignment ? 'unauthenticated' : 'not_found');
      if (assignment.state !== 'ACTIVE') return deny('already_revoked');
      if (assignment.role === 'OWNER' && activeOwnerCount(db, now) <= 1) return deny('last_owner');
      if (assignment.actorId === executor.actorId) return deny('self_revocation');
      if (assignment.actorId === approval?.makerActorId) return deny('self_revocation');
      const payload = { assignmentId, reason: safeReason(reason) };
      const consumed = consumeInDatabase(db, approvalId, input, 'role.revoke', { kind: 'role', id: assignmentId }, payload, version, correlationId, now);
      if (!consumed.ok) return deny(consumed.reason);
      assignment.state = 'REVOKED'; assignment.revokedAt = now.toISOString(); assignment.revokedBy = executor.actorId;
      if (!db.assignments.some((item) => item.actorId === assignment.actorId && assignmentActive(item, now))) {
        const target = db.actors.find((actor) => actor.actorId === assignment.actorId); if (target) { target.status = 'REVOKED'; target.revokedAt = now.toISOString(); target.updatedAt = now.toISOString(); }
      }
      appendAudit(db, { actorId: executor.actorId, roles: activeRoles(db, executor.actorId, now), permission: 'role.revoke', scope: summarizeScopes(assignment.scopes), action: 'role.revoke.execute', makerActorId: consumed.approval.makerActorId, approverActorId: consumed.approval.approverActorId, approvalId, approvalVersion: version, requestDigest: consumed.approval.requestDigest, decision: 'ALLOW', timestamp: now.toISOString(), correlationId: hash(correlationId) });
      await this.write(db);
      return { ok: true, assignment } as const;
    });
  }

  async createSignedCallback(input: AuthorizationActorInput, permission: Permission, action: string, resource: ResourceRef, expiresAt: Date, correlationId: string, now = new Date()): Promise<{ ok: true; payload: string } | { ok: false; reason: string }> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const decision = authorizeInDatabase(db, input, permission, resource, now);
      if (!decision.ok) { auditDecision(db, input, decision, permission, resource, correlationId, now); await this.write(db); return { ok: false, reason: decision.reason } as const; }
      if (expiresAt <= now || expiresAt.getTime() - now.getTime() > 15 * 60_000 || !/^[a-z0-9_.-]{1,32}$/i.test(action)) { appendApprovalDenial(db, input, 'callback.create', 'invalid_callback', correlationId, now); await this.write(db); return { ok: false, reason: 'invalid_callback' } as const; }
      const callbackId = randomBytes(6).toString('hex');
      db.callbacks.push({ callbackId, actorId: decision.actor.actorId, permission, action, resource: normalizeResource(resource), expiresAt: expiresAt.toISOString(), state: 'ACTIVE', createdAt: now.toISOString() });
      const signature = callbackSignature(this.callbackSecret, callbackId);
      appendAudit(db, eventFor(decision.actor, decision, `callback.create.${action}`, correlationId, now, 'ALLOW'));
      await this.write(db);
      return { ok: true, payload: `rb1:${callbackId}:${signature}` } as const;
    });
  }

  async consumeSignedCallback(payload: string, input: AuthorizationActorInput, correlationId: string, now = new Date()): Promise<{ ok: true; action: string; resource: ResourceRef } | { ok: false; reason: 'forged' | 'expired' | 'replayed' | 'actor_mismatch' | 'unauthorized' }> {
    const match = payload.match(/^rb1:([a-f0-9]{12}):([a-f0-9]{16})$/);
    if (!match || !safeEqual(match[2], callbackSignature(this.callbackSecret, match?.[1] ?? ''))) { await this.auditCallbackDenial(input, 'forged', correlationId, now); return { ok: false, reason: 'forged' }; }
    return withFileLock(this.filePath, async () => {
      const db = await this.read();
      const callback = db.callbacks.find((item) => item.callbackId === match[1]);
      const deny = async (reason: 'forged' | 'expired' | 'replayed' | 'actor_mismatch' | 'unauthorized') => { appendApprovalDenial(db, input, 'callback.consume', reason, correlationId, now); await this.write(db); return { ok: false, reason } as const; };
      if (!callback) return deny('forged');
      if (callback.state === 'CONSUMED') return deny('replayed');
      if (new Date(callback.expiresAt) <= now) return deny('expired');
      const actor = authenticateInDatabase(db, input);
      if (!actor || actor.actorId !== callback.actorId) return deny('actor_mismatch');
      const auth = hasAuthorization(db, actor, callback.permission, callback.resource, now);
      if (!auth.ok) return deny('unauthorized');
      callback.state = 'CONSUMED'; callback.consumedAt = now.toISOString();
      appendAudit(db, eventFor(actor, auth, `callback.consume.${callback.action}`, correlationId, now, 'CONSUMED'));
      await this.write(db);
      return { ok: true, action: callback.action, resource: callback.resource } as const;
    });
  }

  async actors(): Promise<AuthorizationActor[]> { return (await this.read()).actors; }
  async assignments(): Promise<RoleAssignment[]> { return (await this.read()).assignments; }
  async approvals(): Promise<ApprovalRequest[]> { return (await this.read()).approvals; }
  async audit(): Promise<AuthorizationAuditEvent[]> { return (await this.read()).audit; }
  async privilegedRecipients(now = new Date()): Promise<number[]> {
    const db = await this.read();
    return db.actors.filter((actor) => actor.status === 'ACTIVE' && db.assignments.some((assignment) => assignment.actorId === actor.actorId && assignmentActive(assignment, now))).map((actor) => actor.telegramUserId);
  }

  private async decideWithoutPayload(approvalId: string, input: AuthorizationActorInput, state: 'REJECTED' | 'REVOKED', correlationId: string, now: Date): Promise<ApprovalResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.read(); const approval = db.approvals.find((item) => item.approvalId === approvalId);
      const deny = async (reason: ApprovalFailureReason): Promise<ApprovalResult> => { appendApprovalDenial(db, input, `approval.${state.toLowerCase()}.${approval?.action ?? 'unknown'}`, reason, correlationId, now, approval); await this.write(db); return { ok: false, reason }; };
      if (!approval) return deny('not_found');
      const actor = authenticateInDatabase(db, input); if (!actor) return deny(validActorInput(input) ? 'inactive' : 'unauthenticated');
      if (state === 'REJECTED' && actor.actorId === approval.makerActorId) return deny('self_approval');
      const permission = state === 'REJECTED' ? APPROVAL_POLICIES[approval.action].approver : APPROVAL_POLICIES[approval.action].maker;
      const auth = hasAuthorization(db, actor, permission, approval.resource, now); if (!auth.ok) return deny(auth.reason);
      if (approval.state !== 'PENDING' && !(state === 'REVOKED' && approval.state === 'APPROVED')) return deny(approval.state === 'CONSUMED' ? 'reused' : 'wrong_state');
      if (state === 'REVOKED' && actor.actorId !== approval.makerActorId && !hasAuthorization(db, actor, 'role.revoke', { kind: 'system' }, now).ok) return deny('permission_missing');
      approval.state = state; approval.approverActorId = state === 'REJECTED' ? actor.actorId : approval.approverActorId; approval.decidedAt = now.toISOString();
      appendAudit(db, eventFor(actor, auth, `approval.${state.toLowerCase()}.${approval.action}`, correlationId, now, state, approval)); await this.write(db);
      return { ok: true, approval, status: 'approved' } as const;
    });
  }

  private async auditCallbackDenial(input: AuthorizationActorInput, reason: string, correlationId: string, now: Date): Promise<void> {
    await withFileLock(this.filePath, async () => { const db = await this.read(); if (appendApprovalDenial(db, input, 'callback.consume', reason, correlationId, now)) await this.write(db); });
  }

  private async read(): Promise<AuthorizationDatabase> {
    const raw = await readJson<LegacyAuthorizationDatabase>(this.filePath, {});
    if (raw.schemaVersion === undefined || raw.schemaVersion === null) {
      if (raw.actors && raw.actors.length > 0) {
        throw new MigrationRequiredError('Authorization data needs migration. Run: node dist/migrationCli.js migrate');
      }
      return { schemaVersion: AUTHORIZATION_SCHEMA_VERSION, actors: [], assignments: [], approvals: [], callbacks: [], audit: [], denialBuckets: [] };
    }
    if (raw.schemaVersion < AUTHORIZATION_SCHEMA_VERSION) {
      throw new MigrationRequiredError(`Authorization schema version ${raw.schemaVersion} < ${AUTHORIZATION_SCHEMA_VERSION}. Run: node dist/migrationCli.js migrate`);
    }
    if (raw.schemaVersion > AUTHORIZATION_SCHEMA_VERSION) {
      throw new Error(`Unsupported authorization schema version ${raw.schemaVersion}. Upgrade this software.`);
    }
    return raw as AuthorizationDatabase;
  }

  private async write(db: AuthorizationDatabase): Promise<void> { await atomicWriteJson(this.filePath, db); }
}

export function deriveAuthorizationActor(context: { from?: { id?: unknown }; chat?: { id?: unknown; type?: unknown } }): AuthorizationActorInput {
  return { telegramUserId: context.from?.id, telegramChatId: context.chat?.id, chatType: context.chat?.type };
}

export function authorizationCallbackSecret(botToken: string): string { return createHmac('sha256', botToken).update('wst-academy:authorization-callback:v1').digest('hex'); }
export function roleAssignmentPayload(targetTelegramUserId: number, role: Role, scopes: ResourceScope[], reason: string, expiresAt?: Date): unknown { return rolePayload(targetTelegramUserId, role, scopes, reason, expiresAt); }
export function roleRevocationPayload(assignmentId: string, reason: string): unknown { return { assignmentId, reason: safeReason(reason) }; }
export function approvalRequestDigest(action: ApprovalAction, resource: ResourceRef, payload: unknown, version: string): string { return digestRequest(action, resource, payload, version); }
export function rollbackAuthorizationDatabase(db: AuthorizationDatabase): Omit<AuthorizationDatabase, 'schemaVersion'> { const { schemaVersion: _schemaVersion, ...rest } = db; return rest; }
export function migrateAuthorizationDatabase(raw: LegacyAuthorizationDatabase): AuthorizationDatabase {
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 0 && raw.schemaVersion !== 1) throw new Error('Unsupported authorization schema version.');
  const approvals = Array.isArray(raw.approvals) ? raw.approvals.filter(validStoredApproval).map((approval) => ({ ...approval, summary: Array.isArray(approval.summary) ? approval.summary.map((item) => safeApprovalSummary(String(item))) : [] })) : [];
  const callbacks = Array.isArray(raw.callbacks) ? raw.callbacks.filter(validStoredCallback) : [];
  const actors = Array.isArray(raw.actors) ? raw.actors.filter((actor) => actor && typeof actor === 'object') : [];
  const assignments = Array.isArray(raw.assignments) ? raw.assignments.filter((assignment) => assignment && typeof assignment === 'object') : [];
  const audit = Array.isArray(raw.audit) ? raw.audit.filter(validStoredAudit).map(sanitizeAudit) : [];
  const denialBuckets = Array.isArray(raw.denialBuckets) ? raw.denialBuckets.filter((bucket) => bucket && typeof bucket.key === 'string' && typeof bucket.at === 'string') : [];
  const db: AuthorizationDatabase = { schemaVersion: 1, actors, assignments, approvals, callbacks, audit, denialBuckets };
  const conflicts = new Set<AuthorizationActor>(); const keys = new Map<string, AuthorizationActor>();
  for (const actor of db.actors) { for (const key of [`actor:${actor.actorId}`, `telegram:${actor.telegramUserId}`]) { const prior = keys.get(key); if (prior) { conflicts.add(prior); conflicts.add(actor); } else keys.set(key, actor); } if (!Number.isSafeInteger(actor.telegramUserId) || actor.telegramUserId <= 0) conflicts.add(actor); }
  for (const actor of conflicts) { actor.status = 'REVOKED'; actor.revokedAt ??= actor.updatedAt; }
  const actorIds = new Set(db.actors.map((actor) => actor.actorId));
  for (const assignment of db.assignments) {
    if (!actorIds.has(assignment.actorId) || !ROLES.includes(assignment.role) || !Array.isArray(assignment.scopes) || !validScopes(assignment.scopes) || !Number.isFinite(new Date(assignment.effectiveAt).getTime()) || (assignment.expiresAt !== undefined && !Number.isFinite(new Date(assignment.expiresAt).getTime()))) assignment.state = 'REVOKED';
  }
  const duplicateCallbacks = new Set<string>(); const callbackIds = new Set<string>();
  for (const callback of db.callbacks) { if (callbackIds.has(callback.callbackId)) duplicateCallbacks.add(callback.callbackId); else callbackIds.add(callback.callbackId); }
  for (const callback of db.callbacks) if (duplicateCallbacks.has(callback.callbackId)) callback.state = 'CONSUMED';
  return db;
}
export function isSafeAuthorizationAudit(event: AuthorizationAuditEvent): boolean {
  return Object.keys(event).every((key) => ['eventId', 'actorId', 'roles', 'permission', 'scope', 'action', 'makerActorId', 'approverActorId', 'approvalId', 'approvalVersion', 'requestDigest', 'decision', 'timestamp', 'correlationId'].includes(key))
    && !/\+998\d{9}|BOT_TOKEN|callback secret|private message|raw payload|free.?text/i.test(JSON.stringify(event));
}

function validActorInput(input: AuthorizationActorInput): boolean { return Number.isSafeInteger(input.telegramUserId) && Number.isSafeInteger(input.telegramChatId) && Number(input.telegramUserId) > 0 && input.telegramUserId === input.telegramChatId && input.chatType === 'private'; }
function authenticateInDatabase(db: AuthorizationDatabase, input: AuthorizationActorInput): AuthorizationActor | undefined { if (!validActorInput(input)) return undefined; return db.actors.find((actor) => actor.telegramUserId === input.telegramUserId && actor.status === 'ACTIVE'); }
function authorizeInDatabase(db: AuthorizationDatabase, input: AuthorizationActorInput, permission: Permission, resource: ResourceRef, now: Date): AuthorizationDecision {
  if (!validActorInput(input)) return { ok: false, reason: 'unauthenticated' };
  const actor = db.actors.find((item) => item.telegramUserId === input.telegramUserId);
  if (!actor || actor.status !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  return hasAuthorization(db, actor, permission, resource, now);
}
function hasAuthorization(db: AuthorizationDatabase, actor: AuthorizationActor, permission: Permission, resource: ResourceRef, now: Date): AuthorizationDecision {
  const assignments = db.assignments.filter((item) => item.actorId === actor.actorId && assignmentActive(item, now)); const roles = [...new Set(assignments.map((item) => item.role))];
  const permitted = assignments.filter((item) => ROLE_PERMISSIONS[item.role].includes(permission)); if (!permitted.length) return { ok: false, reason: 'permission_missing' };
  const scopes = permitted.flatMap((item) => item.scopes); if (!scopes.some((scope) => scopeAllows(scope, resource, permission))) return { ok: false, reason: 'scope_missing' };
  return { ok: true, actor, roles, permission, scopes };
}
function assignmentActive(item: RoleAssignment, now: Date): boolean { return item.state === 'ACTIVE' && new Date(item.effectiveAt) <= now && (!item.expiresAt || new Date(item.expiresAt) > now); }
function activeRoles(db: AuthorizationDatabase, actorId: string, now: Date): Role[] { return [...new Set(db.assignments.filter((item) => item.actorId === actorId && assignmentActive(item, now)).map((item) => item.role))]; }
function activeOwnerCount(db: AuthorizationDatabase, now: Date): number { return new Set(db.assignments.filter((item) => item.role === 'OWNER' && assignmentActive(item, now) && db.actors.some((actor) => actor.actorId === item.actorId && actor.status === 'ACTIVE')).map((item) => item.actorId)).size; }
function scopeAllows(scope: ResourceScope, resource: ResourceRef, permission: Permission): boolean {
  if (scope.kind !== '*' && scope.kind !== resource.kind) return false;
  if (scope.mode === 'audit_only') return permission.endsWith('.audit.view') || permission === 'system.audit.view' || permission === 'role.view' || permission === 'deadletter.view';
  if (scope.mode === 'all') return true;
  if (!resource.id && scope.mode === 'assigned') return false;
  if (scope.resourceIds?.length && (!resource.id || !scope.resourceIds.includes(resource.id))) return false;
  if (scope.programs?.length && (!resource.program || !scope.programs.includes(resource.program))) return false;
  if (scope.regions?.length && (!resource.region || !scope.regions.includes(resource.region))) return false;
  if (scope.channels?.length && (!resource.channel || !scope.channels.includes(resource.channel))) return false;
  if (scope.campaigns?.length && (!resource.campaign || !scope.campaigns.includes(resource.campaign))) return false;
  return Boolean(scope.resourceIds?.length || scope.programs?.length || scope.regions?.length || scope.channels?.length || scope.campaigns?.length);
}
function validScopes(scopes: ResourceScope[]): boolean { return scopes.length > 0 && scopes.every((scope) => scope && typeof scope === 'object' && ['*', 'applicant', 'publication', 'followup', 'webhook', 'role', 'system'].includes(scope.kind) && ['all', 'assigned', 'selected', 'audit_only'].includes(scope.mode) && [scope.resourceIds, scope.programs, scope.regions, scope.channels, scope.campaigns].every(validScopeList) && (scope.mode === 'all' || scope.mode === 'audit_only' || Boolean(scope.resourceIds?.length || scope.programs?.length || scope.regions?.length || scope.channels?.length || scope.campaigns?.length))); }
function validScopeList(values: string[] | undefined): boolean { return values === undefined || (Array.isArray(values) && values.length <= 500 && values.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 120)); }
function normalizeScopes(scopes: ResourceScope[]): ResourceScope[] { return scopes.map((scope) => ({ kind: scope.kind, mode: scope.mode, resourceIds: cleanList(scope.resourceIds), programs: cleanList(scope.programs), regions: cleanList(scope.regions), channels: cleanList(scope.channels), campaigns: cleanList(scope.campaigns) })); }
function cleanList(values: string[] | undefined): string[] | undefined { if (!values) return undefined; return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 500); }
function normalizeResource(resource: ResourceRef): ResourceRef {
  const rawId = valueOrUndefined(resource.id);
  const id = resource.kind === 'role' && rawId && /^\d+$/.test(rawId) ? `sha256:${hash(rawId)}` : safeResource(rawId);
  return { kind: resource.kind, id, program: safeResource(valueOrUndefined(resource.program)), region: safeResource(valueOrUndefined(resource.region)), channel: safeResource(valueOrUndefined(resource.channel)), campaign: safeResource(valueOrUndefined(resource.campaign)) };
}
function valueOrUndefined(value: string | undefined): string | undefined { return value?.trim() || undefined; }
function safeResource(value: string | undefined): string | undefined { if (!value) return undefined; return /^[\p{L}\p{N}_.:@/+ -]{1,120}$/u.test(value) ? value : `sha256:${hash(value)}`; }
function summarizeScopes(scopes: ResourceScope[]): string[] { return scopes.map((scope) => `${scope.kind}:${scope.mode}`).sort(); }
function validVersion(value: string): boolean { return /^[a-z0-9._-]{1,40}$/i.test(value); }
function validStoredResource(resource: unknown): resource is ResourceRef { return Boolean(resource && typeof resource === 'object' && ['applicant', 'publication', 'followup', 'webhook', 'role', 'system'].includes((resource as ResourceRef).kind)); }
function validStoredApproval(approval: ApprovalRequest): boolean { return Boolean(approval && typeof approval === 'object' && approval.action in APPROVAL_POLICIES && ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED', 'CONSUMED', 'EXPIRED'].includes(approval.state) && validStoredResource(approval.resource) && typeof approval.approvalId === 'string' && typeof approval.makerActorId === 'string' && /^[a-f0-9]{64}$/i.test(approval.resourceDigest) && /^[a-f0-9]{64}$/i.test(approval.requestDigest) && validVersion(approval.version) && Number.isFinite(new Date(approval.createdAt).getTime()) && Number.isFinite(new Date(approval.expiresAt).getTime())); }
function validStoredCallback(callback: CallbackIntent): boolean { return Boolean(callback && typeof callback === 'object' && PERMISSIONS.includes(callback.permission) && ['ACTIVE', 'CONSUMED'].includes(callback.state) && /^[a-f0-9]{12}$/.test(callback.callbackId) && typeof callback.actorId === 'string' && validStoredResource(callback.resource) && Number.isFinite(new Date(callback.createdAt).getTime()) && Number.isFinite(new Date(callback.expiresAt).getTime())); }
function validStoredAudit(event: AuthorizationAuditEvent): boolean { return Boolean(event && typeof event === 'object' && typeof event.eventId === 'string' && typeof event.actorId === 'string' && Array.isArray(event.roles) && Array.isArray(event.scope) && typeof event.action === 'string' && typeof event.decision === 'string' && typeof event.timestamp === 'string' && Number.isFinite(new Date(event.timestamp).getTime()) && typeof event.correlationId === 'string'); }
function safeReason(value: string): string {
  return value.trim()
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-number]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted-email]')
    .replace(/@[a-z0-9_]{4,}/gi, '[redacted-handle]')
    .slice(0, 200);
}
function summarizeApprovalPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .slice(0, 10)
    .map(([key, value]) => {
      if (/reason|note|message|text|phone|name/i.test(key)) return safeApprovalSummary(`${key}Digest=${hash(stableJson(value)).slice(0, 16)}`);
      if (['string', 'number', 'boolean'].includes(typeof value)) return safeApprovalSummary(`${key}=${String(value)}`);
      if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) return safeApprovalSummary(`${key}=${value.join('|')}`);
      if (key === 'scopes' && Array.isArray(value)) return safeApprovalSummary(`${key}=${value.map((scope) => summarizeScopeForReview(scope)).join('|')}`);
      return safeApprovalSummary(`${key}Digest=${hash(stableJson(value)).slice(0, 16)}`);
    });
}
function summarizeScopeForReview(value: unknown): string {
  if (!value || typeof value !== 'object') return 'invalid';
  const scope = value as ResourceScope;
  const selectors = [scope.resourceIds, scope.programs, scope.regions, scope.channels, scope.campaigns].filter(Array.isArray).flat().map((item) => String(item)).join(',');
  return `${scope.kind}:${scope.mode}${selectors ? `:${selectors}` : ''}`;
}
function safeApprovalSummary(value: string): string { return safeReason(value).replace(/[^a-z0-9_.*,:=+@/|\[\]-]/gi, '').slice(0, 240); }
function rolePayload(targetTelegramUserId: number, role: Role, scopes: ResourceScope[], reason: string, expiresAt?: Date): unknown { return { targetRef: hash(String(targetTelegramUserId)), role, scopes: normalizeScopes(scopes), reason: safeReason(reason), expiresAt: expiresAt?.toISOString() }; }
function digestResource(resource: ResourceRef): string { return hash(stableJson(normalizeResource(resource))); }
function digestRequest(action: ApprovalAction, resource: ResourceRef, payload: unknown, version: string): string { return hash(stableJson({ action, resource: normalizeResource(resource), payload, version })); }
function validateApprovalRequest(approval: ApprovalRequest, payload: unknown, version: string, now: Date): ApprovalFailureReason | undefined {
  if (approval.state === 'REVOKED') return 'revoked'; if (approval.state === 'CONSUMED') return 'reused'; if (new Date(approval.expiresAt) <= now) { approval.state = 'EXPIRED'; return 'expired'; } if (approval.version !== version) return 'version_mismatch'; if (approval.requestDigest !== digestRequest(approval.action, approval.resource, payload, version)) return 'payload_mismatch'; return undefined;
}
function consumeInDatabase(db: AuthorizationDatabase, approvalId: string, input: AuthorizationActorInput, action: ApprovalAction, resource: ResourceRef, payload: unknown, version: string, correlationId: string, now: Date): ApprovalResult {
  const approval = db.approvals.find((item) => item.approvalId === approvalId); if (!approval) return { ok: false, reason: 'not_found' };
  if (approval.action !== action || approval.resourceDigest !== digestResource(resource)) return { ok: false, reason: 'payload_mismatch' };
  const invalid = validateApprovalRequest(approval, payload, version, now); if (invalid) return { ok: false, reason: invalid };
  if (approval.state !== 'APPROVED' || !approval.approverActorId) return { ok: false, reason: 'wrong_state' };
  const executor = authenticateInDatabase(db, input); if (!executor) return { ok: false, reason: validActorInput(input) ? 'inactive' : 'unauthenticated' };
  const policy = APPROVAL_POLICIES[action]; const executorAuth = hasAuthorization(db, executor, policy.executor, resource, now); if (!executorAuth.ok) return { ok: false, reason: executorAuth.reason };
  const maker = db.actors.find((item) => item.actorId === approval.makerActorId && item.status === 'ACTIVE'); const approver = db.actors.find((item) => item.actorId === approval.approverActorId && item.status === 'ACTIVE');
  if (!maker || !approver || !hasAuthorization(db, maker, policy.maker, resource, now).ok || !hasAuthorization(db, approver, policy.approver, resource, now).ok) return { ok: false, reason: 'inactive' };
  if (maker.actorId === approver.actorId) return { ok: false, reason: 'self_approval' };
  approval.state = 'CONSUMED'; approval.consumedAt = now.toISOString();
  appendAudit(db, eventFor(executor, executorAuth, `approval.consume.${action}`, correlationId, now, 'CONSUMED', approval));
  return { ok: true, approval, status: 'consumed' };
}
function auditDecision(db: AuthorizationDatabase, input: AuthorizationActorInput, decision: AuthorizationDecision, permission: Permission, resource: ResourceRef, correlationId: string, now: Date, purpose?: string, requestedAction?: string): void {
  const action = requestedAction?.trim() || permission;
  if (decision.ok) { appendAudit(db, eventFor(decision.actor, decision, purpose ? `authorize.${action}.purpose` : `authorize.${action}`, correlationId, now, 'ALLOW')); return; }
  const actor = validActorInput(input) ? db.actors.find((item) => item.telegramUserId === input.telegramUserId) : undefined;
  const key = hash(`${actor?.actorId ?? 'anonymous'}:${permission}:${digestResource(resource)}:${decision.reason}`); const cutoff = now.getTime() - 60_000; db.denialBuckets = db.denialBuckets.filter((item) => new Date(item.at).getTime() > cutoff);
  if (db.denialBuckets.some((item) => item.key === key)) return; db.denialBuckets.push({ key, at: now.toISOString() });
  appendAudit(db, { actorId: actor?.actorId ?? 'anonymous', roles: [], permission, scope: [], action: `authorize.${action}.${decision.reason}`, decision: 'DENY', timestamp: now.toISOString(), correlationId: hash(correlationId), requestDigest: digestResource(resource) });
}
function appendApprovalDenial(db: AuthorizationDatabase, input: AuthorizationActorInput, action: string, reason: string, correlationId: string, now: Date, approval?: ApprovalRequest): boolean {
  const actor = validActorInput(input) ? db.actors.find((item) => item.telegramUserId === input.telegramUserId) : undefined;
  const key = hash(`${actor?.actorId ?? 'anonymous'}:${action}:${reason}:${approval?.requestDigest ?? ''}`);
  const cutoff = now.getTime() - 60_000;
  db.denialBuckets = db.denialBuckets.filter((item) => new Date(item.at).getTime() > cutoff);
  if (db.denialBuckets.some((item) => item.key === key)) return false;
  db.denialBuckets.push({ key, at: now.toISOString() });
  appendAudit(db, {
    actorId: actor?.actorId ?? 'anonymous',
    roles: actor ? activeRoles(db, actor.actorId, now) : [],
    scope: [],
    action: `${action}.${reason}`,
    makerActorId: approval?.makerActorId,
    approverActorId: approval?.approverActorId,
    approvalId: approval?.approvalId,
    approvalVersion: approval?.version,
    requestDigest: approval?.requestDigest,
    decision: 'DENY',
    timestamp: now.toISOString(),
    correlationId,
  });
  return true;
}
function eventFor(actor: AuthorizationActor, auth: Extract<AuthorizationDecision, { ok: true }>, action: string, correlationId: string, now: Date, decision: AuthorizationAuditEvent['decision'], approval?: ApprovalRequest): AuthorizationAuditEvent { return { eventId: randomUUID(), actorId: actor.actorId, roles: auth.roles, permission: auth.permission, scope: summarizeScopes(auth.scopes), action, makerActorId: approval?.makerActorId, approverActorId: approval?.approverActorId, approvalId: approval?.approvalId, approvalVersion: approval?.version, requestDigest: approval?.requestDigest, decision, timestamp: now.toISOString(), correlationId: hash(correlationId) }; }
function appendAudit(db: AuthorizationDatabase, event: Omit<AuthorizationAuditEvent, 'eventId'> | AuthorizationAuditEvent): void { db.audit.push(sanitizeAudit('eventId' in event ? event : { ...event, eventId: randomUUID() })); if (db.audit.length > 20_000) db.audit.splice(0, db.audit.length - 20_000); }
function sanitizeAudit(event: AuthorizationAuditEvent): AuthorizationAuditEvent { return { eventId: /^[a-f0-9-]{8,64}$/i.test(event.eventId) ? event.eventId : randomUUID(), actorId: safeIdentifier(event.actorId), roles: event.roles.filter((role) => ROLES.includes(role)), permission: event.permission && PERMISSIONS.includes(event.permission) ? event.permission : undefined, scope: event.scope.map((item) => item.replace(/[^a-z_*:-]/gi, '').slice(0, 60)).slice(0, 20), action: event.action.replace(/[^a-z0-9._-]/gi, '').slice(0, 100), makerActorId: event.makerActorId ? safeIdentifier(event.makerActorId) : undefined, approverActorId: event.approverActorId ? safeIdentifier(event.approverActorId) : undefined, approvalId: event.approvalId ? safeIdentifier(event.approvalId) : undefined, approvalVersion: event.approvalVersion?.replace(/[^a-z0-9._-]/gi, '').slice(0, 40), requestDigest: event.requestDigest?.replace(/[^a-f0-9]/gi, '').slice(0, 64), decision: ['ALLOW', 'DENY', 'REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'CONSUMED'].includes(event.decision) ? event.decision : 'DENY', timestamp: new Date(event.timestamp).toISOString(), correlationId: /^[a-f0-9]{64}$/i.test(event.correlationId) ? event.correlationId.toLowerCase() : hash(event.correlationId) }; }
function safeIdentifier(value: string): string { return /^[a-z0-9_-]{1,80}$/i.test(value) ? value : `sha256-${hash(value).slice(0, 24)}`; }
function callbackSignature(secret: string, callbackId: string): string { return createHmac('sha256', secret).update(`rb1:${callbackId}`).digest('hex').slice(0, 16); }
function safeEqual(left: string, right: string): boolean { const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right); return a.length === b.length && timingSafeEqual(a, b); }
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`; return JSON.stringify(value); }
