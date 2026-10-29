import { DurableObject } from 'cloudflare:workers';
import { getLimits } from './core';

export class ClassroomQuota extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)');
  }

  private buckets(student: string) {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const dayEnd = Date.parse(day + 'T00:00:00Z') + 86_400_000;
    const minute = Math.floor(now / 60_000);
    const limits = getLimits(this.env);
    return { now, limits, rows: [
      { key: `class:${day}`, limit: limits.dailyClass, expires: dayEnd, type: 'class_daily' },
      { key: `student:${student}:${day}`, limit: limits.dailyStudent, expires: dayEnd, type: 'student_daily' },
      { key: `minute:${student}:${minute}`, limit: limits.minuteStudent, expires: (minute + 1) * 60_000, type: 'student_minute' },
    ] };
  }

  private count(key: string): number {
    return this.ctx.storage.sql.exec<{ count: number }>('SELECT count FROM counters WHERE key = ?', key).toArray()[0]?.count ?? 0;
  }

  // This object coordinates only one classroom's budget. Provider I/O remains in the Worker.
  async reserve(student: string) {
    const { now, rows } = this.buckets(student);
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM counters WHERE expires <= ?', now);
      for (const row of rows) {
        if (this.count(row.key) >= row.limit) return { allowed: false as const, reason: row.type, retryAfter: Math.max(1, Math.ceil((row.expires - now) / 1_000)), remaining: { classroom: Math.max(0, rows[0].limit - this.count(rows[0].key)), student: Math.max(0, rows[1].limit - this.count(rows[1].key)) } };
      }
      for (const row of rows) this.ctx.storage.sql.exec('INSERT INTO counters (key, count, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1', row.key, row.expires);
      return { allowed: true as const, reason: null, retryAfter: 0, remaining: { classroom: rows[0].limit - this.count(rows[0].key), student: rows[1].limit - this.count(rows[1].key) } };
    });
  }

  async usage(student: string) {
    const { rows, limits } = this.buckets(student);
    return { remaining: { classroom: Math.max(0, rows[0].limit - this.count(rows[0].key)), student: Math.max(0, rows[1].limit - this.count(rows[1].key)) }, limits, resetsAt: new Date(rows[0].expires).toISOString() };
  }
}
