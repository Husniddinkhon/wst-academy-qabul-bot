import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ChannelPostStatus = 'Draft' | 'Scheduled' | 'Publishing' | 'Published' | 'Failed' | 'Cancelled';

export interface ChannelPost {
  id: string;
  text: string;
  status: ChannelPostStatus;
  createdAt: string;
  createdBy?: number;
  scheduledAt?: string;
  scheduledBy?: number;
  approvedAt?: string;
  approvedBy?: number;
  cancelledAt?: string;
  cancelledBy?: number;
  campaignId?: string;
  publishStartedAt?: string;
  publishedAt?: string;
  publishedBy?: number;
  publishedMessageId?: number;
  publishAttemptId?: string;
  attempts: number;
  lastError?: string;
  failedAt?: string;
  photoFileId?: string;
}

interface ChannelPostDatabase { posts: ChannelPost[] }
export type ClaimResult = { ok: true; post: ChannelPost; attemptId: string } | { ok: false; reason: 'not_found' | 'not_publishable'; post?: ChannelPost };
export type MutationResult = { ok: true; post: ChannelPost } | { ok: false; reason: 'not_found' | 'not_allowed'; post?: ChannelPost };

export class JsonChannelPostStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async create(text: string, photoFileId?: string, createdBy?: number): Promise<ChannelPost> {
    return this.mutate((db) => {
      const post: ChannelPost = { id: randomUUID().slice(0, 8), text, photoFileId, status: 'Draft', createdAt: new Date().toISOString(), createdBy, attempts: 0 };
      db.posts.push(post);
      return post;
    });
  }

  async get(id: string): Promise<ChannelPost | undefined> { return (await this.read()).posts.find((post) => post.id === id); }
  async all(): Promise<ChannelPost[]> { return (await this.read()).posts; }
  async last(limit = 10): Promise<ChannelPost[]> { return (await this.read()).posts.slice(-limit).reverse(); }

  async schedule(id: string, scheduledAt: string, adminId: number, campaignId?: string): Promise<MutationResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (!['Draft', 'Cancelled', 'Failed'].includes(current.status)) return { ok: false, reason: 'not_allowed', post: current } as const;
      const now = new Date().toISOString();
      const post: ChannelPost = { ...current, status: 'Scheduled', scheduledAt, scheduledBy: adminId, approvedAt: now, approvedBy: adminId, campaignId: campaignId || undefined, cancelledAt: undefined, cancelledBy: undefined, lastError: undefined, failedAt: undefined };
      db.posts[index] = post;
      return { ok: true, post } as const;
    });
  }

  async cancel(id: string, adminId: number): Promise<MutationResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (current.status !== 'Scheduled') return { ok: false, reason: 'not_allowed', post: current } as const;
      const post: ChannelPost = { ...current, status: 'Cancelled', cancelledAt: new Date().toISOString(), cancelledBy: adminId };
      db.posts[index] = post;
      return { ok: true, post } as const;
    });
  }

  async claimForPublishing(id: string, publisherId: number, retryFailed = false): Promise<ClaimResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index < 0) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      if (!(current.status === 'Draft' || (retryFailed && current.status === 'Failed'))) return { ok: false, reason: 'not_publishable', post: current } as const;
      return claim(db, index, current, publisherId, new Date());
    });
  }

  async claimNextDue(now: Date, publisherId = 0): Promise<ClaimResult> {
    return this.mutate((db) => {
      const due = db.posts.map(normalizePost).filter((post) => post.status === 'Scheduled' && post.approvedAt && post.scheduledAt && new Date(post.scheduledAt) <= now).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];
      if (!due) return { ok: false, reason: 'not_found' } as const;
      const index = db.posts.findIndex((post) => post.id === due.id);
      return claim(db, index, due, publisherId, now);
    });
  }

  async recoverStalePublishing(cutoff: Date): Promise<ChannelPost[]> {
    return this.mutate((db) => {
      const recovered: ChannelPost[] = [];
      db.posts = db.posts.map((raw) => {
        const post = normalizePost(raw);
        if (post.status !== 'Publishing' || !post.publishStartedAt || new Date(post.publishStartedAt) > cutoff) return post;
        const failed: ChannelPost = { ...post, status: 'Failed', failedAt: new Date().toISOString(), lastError: 'Publish outcome unknown after restart; inspect the channel before manual retry to avoid a duplicate.' };
        recovered.push(failed);
        return failed;
      });
      return recovered;
    });
  }

  async markPublished(id: string, attemptId: string, messageId: number): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, (post) => ({ ...post, status: 'Published', publishedAt: new Date().toISOString(), publishedMessageId: messageId, lastError: undefined, failedAt: undefined }));
  }
  async markFailed(id: string, attemptId: string, error: string): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, (post) => ({ ...post, status: 'Failed', lastError: error, failedAt: new Date().toISOString() }));
  }
  async stats(now = new Date()): Promise<Record<ChannelPostStatus | 'due', number>> {
    const posts = await this.all();
    const result = { Draft: 0, Scheduled: 0, Publishing: 0, Published: 0, Failed: 0, Cancelled: 0, due: 0 };
    for (const post of posts) { result[post.status] += 1; if (post.status === 'Scheduled' && post.scheduledAt && new Date(post.scheduledAt) <= now) result.due += 1; }
    return result;
  }

  private async finishAttempt(id: string, attemptId: string, patch: (post: ChannelPost) => ChannelPost): Promise<ChannelPost | undefined> {
    return this.mutate((db) => { const index = db.posts.findIndex((post) => post.id === id); if (index < 0) return undefined; const current = normalizePost(db.posts[index]); if (current.status !== 'Publishing' || current.publishAttemptId !== attemptId) return undefined; const updated = patch(current); db.posts[index] = updated; return updated; });
  }
  private async mutate<T>(operation: (db: ChannelPostDatabase) => T): Promise<T> {
    let resolveResult!: (value: T) => void; let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const run = async () => { try { const db = await this.read(); const value = operation(db); await this.write(db); resolveResult(value); } catch (error) { rejectResult(error); } };
    this.mutationQueue = this.mutationQueue.then(run, run); await this.mutationQueue; return result;
  }
  private async read(): Promise<ChannelPostDatabase> { try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ChannelPostDatabase; return { posts: Array.isArray(parsed.posts) ? parsed.posts.map(normalizePost) : [] }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { posts: [] }; throw error; } }
  private async write(db: ChannelPostDatabase): Promise<void> { await mkdir(path.dirname(this.filePath), { recursive: true }); const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporaryPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8'); await rename(temporaryPath, this.filePath); }
}

function claim(db: ChannelPostDatabase, index: number, current: ChannelPost, publisherId: number, startedAt: Date): { ok: true; post: ChannelPost; attemptId: string } {
  const attemptId = randomUUID();
  const post: ChannelPost = { ...current, status: 'Publishing', attempts: current.attempts + 1, publishAttemptId: attemptId, publishStartedAt: startedAt.toISOString(), publishedBy: publisherId, lastError: undefined, failedAt: undefined };
  db.posts[index] = post;
  return { ok: true, post, attemptId };
}
function normalizePost(post: ChannelPost): ChannelPost { return { ...post, attempts: Number.isInteger(post.attempts) ? post.attempts : (post.status === 'Published' || post.status === 'Failed' ? 1 : 0) }; }
