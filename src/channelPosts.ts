import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ChannelPostStatus = 'Draft' | 'Publishing' | 'Published' | 'Failed';

export interface ChannelPost {
  id: string;
  text: string;
  status: ChannelPostStatus;
  createdAt: string;
  createdBy?: number;
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

interface ChannelPostDatabase { posts: ChannelPost[]; }

export type ClaimResult =
  | { ok: true; post: ChannelPost; attemptId: string }
  | { ok: false; reason: 'not_found' | 'not_publishable'; post?: ChannelPost };

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

  async claimForPublishing(id: string, publisherId: number, retryFailed = false): Promise<ClaimResult> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index === -1) return { ok: false, reason: 'not_found' } as const;
      const current = normalizePost(db.posts[index]);
      const allowed = current.status === 'Draft' || (retryFailed && current.status === 'Failed');
      if (!allowed) return { ok: false, reason: 'not_publishable', post: current } as const;
      const attemptId = randomUUID();
      const post: ChannelPost = {
        ...current,
        status: 'Publishing',
        attempts: current.attempts + 1,
        publishAttemptId: attemptId,
        publishStartedAt: new Date().toISOString(),
        publishedBy: publisherId,
        lastError: undefined,
        failedAt: undefined,
      };
      db.posts[index] = post;
      return { ok: true, post, attemptId } as const;
    });
  }

  async markPublished(id: string, attemptId: string, messageId: number): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, (post) => ({ ...post, status: 'Published', publishedAt: new Date().toISOString(), publishedMessageId: messageId, lastError: undefined, failedAt: undefined }));
  }

  async markFailed(id: string, attemptId: string, error: string): Promise<ChannelPost | undefined> {
    return this.finishAttempt(id, attemptId, (post) => ({ ...post, status: 'Failed', lastError: error, failedAt: new Date().toISOString() }));
  }

  private async finishAttempt(id: string, attemptId: string, patch: (post: ChannelPost) => ChannelPost): Promise<ChannelPost | undefined> {
    return this.mutate((db) => {
      const index = db.posts.findIndex((post) => post.id === id);
      if (index === -1) return undefined;
      const current = normalizePost(db.posts[index]);
      if (current.status !== 'Publishing' || current.publishAttemptId !== attemptId) return undefined;
      const updated = patch(current);
      db.posts[index] = updated;
      return updated;
    });
  }

  private async mutate<T>(operation: (db: ChannelPostDatabase) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const run = async (): Promise<void> => {
      try {
        const db = await this.read();
        const value = operation(db);
        await this.write(db);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    };
    this.mutationQueue = this.mutationQueue.then(run, run);
    await this.mutationQueue;
    return result;
  }

  private async read(): Promise<ChannelPostDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ChannelPostDatabase;
      return { posts: Array.isArray(parsed.posts) ? parsed.posts.map(normalizePost) : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { posts: [] };
      throw error;
    }
  }

  private async write(db: ChannelPostDatabase): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

function normalizePost(post: ChannelPost): ChannelPost {
  return { ...post, attempts: Number.isInteger(post.attempts) ? post.attempts : (post.status === 'Published' || post.status === 'Failed' ? 1 : 0) };
}
