import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ChannelPost {
  id: string;
  text: string;
  status: 'Draft' | 'Published' | 'Failed';
  createdAt: string;
  publishedAt?: string;
  publishedMessageId?: number;
  lastError?: string;
  photoFileId?: string;
}

interface ChannelPostDatabase { posts: ChannelPost[]; }

export class JsonChannelPostStore {
  constructor(private readonly filePath: string) {}

  async create(text: string, photoFileId?: string): Promise<ChannelPost> {
    const post: ChannelPost = { id: randomUUID().slice(0, 8), text, photoFileId, status: 'Draft', createdAt: new Date().toISOString() };
    const db = await this.read();
    db.posts.push(post);
    await this.write(db);
    return post;
  }

  async get(id: string): Promise<ChannelPost | undefined> { return (await this.read()).posts.find((post) => post.id === id); }
  async last(limit = 10): Promise<ChannelPost[]> { return (await this.read()).posts.slice(-limit).reverse(); }

  async update(id: string, patch: Partial<ChannelPost>): Promise<ChannelPost | undefined> {
    const db = await this.read();
    const index = db.posts.findIndex((post) => post.id === id);
    if (index === -1) return undefined;
    db.posts[index] = { ...db.posts[index], ...patch, id };
    await this.write(db);
    return db.posts[index];
  }

  private async read(): Promise<ChannelPostDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ChannelPostDatabase;
      return { posts: Array.isArray(parsed.posts) ? parsed.posts : [] };
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
