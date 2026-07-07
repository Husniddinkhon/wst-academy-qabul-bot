import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Lead } from './types.js';

interface LeadDatabase {
  leads: Lead[];
}

export class JsonLeadStore {
  constructor(private readonly filePath: string) {}

  async add(lead: Lead): Promise<void> {
    const db = await this.readDatabase();
    db.leads.push(lead);
    await this.writeDatabase(db);
  }

  async all(): Promise<Lead[]> {
    const db = await this.readDatabase();
    return [...db.leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async today(now = new Date()): Promise<Lead[]> {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return (await this.all()).filter((lead) => {
      const createdAt = new Date(lead.createdAt);
      return createdAt >= start && createdAt < end;
    });
  }

  async last(limit = 10): Promise<Lead[]> {
    return (await this.all()).slice(0, limit);
  }

  async stats(): Promise<{ total: number; today: number; last7Days: number }> {
    const leads = await this.all();
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    return {
      total: leads.length,
      today: (await this.today(now)).length,
      last7Days: leads.filter((lead) => new Date(lead.createdAt) >= sevenDaysAgo).length,
    };
  }

  async toCsv(leads?: Lead[]): Promise<string> {
    const exportLeads = leads ?? (await this.all());
    const headers: (keyof Lead)[] = [
      'id',
      'createdAt',
      'telegramId',
      'username',
      'firstName',
      'lastName',
      'fullName',
      'phone',
      'age',
      'district',
      'experience',
      'preferredTime',
      'notes',
      'source',
      'status',
    ];

    const rows = exportLeads.map((lead) => headers.map((header) => csvEscape(String(lead[header] ?? ''))).join(','));
    return [headers.join(','), ...rows].join('\n');
  }

  private async readDatabase(): Promise<LeadDatabase> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as LeadDatabase;
      return { leads: Array.isArray(parsed.leads) ? parsed.leads : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { leads: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(db: LeadDatabase): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
