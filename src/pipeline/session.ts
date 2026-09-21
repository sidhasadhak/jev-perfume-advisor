import { randomUUID } from 'node:crypto';
import type { Session } from '../types.js';
import { EMPTY_FACETS } from '../types.js';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** In-memory sessions with idle expiry and a hard cap (oldest evicted first). */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs = 2 * 60 * 60 * 1000,
    private readonly max = 5000,
  ) {}

  /**
   * Returns the session for `id`, creating it if unknown. A well-formed but
   * unknown id (e.g. after a server restart) starts a fresh session under that
   * id so clients keep working without a handshake.
   */
  getOrCreate(id?: string): Session {
    this.sweep();
    const key = id && ID_RE.test(id) ? id : randomUUID();
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        id: key,
        turns: [],
        facets: structuredClone(EMPTY_FACETS),
        lastShown: [],
        seen: [],
        lastBullets: {},
        updatedAt: Date.now(),
      };
      this.sessions.set(key, s);
      if (this.sessions.size > this.max) this.evictOldest();
    }
    return s;
  }

  reset(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * A copy of a session under a new id, for a duplicated browser tab: both tabs keep
   * the conversation so far, then go their own ways. Undefined for an unknown id.
   */
  fork(id: string): Session | undefined {
    this.sweep();
    const src = ID_RE.test(id) ? this.sessions.get(id) : undefined;
    if (!src) return undefined;
    const copy: Session = { ...structuredClone(src), id: randomUUID(), updatedAt: Date.now() };
    this.sessions.set(copy.id, copy);
    if (this.sessions.size > this.max) this.evictOldest();
    return copy;
  }

  get size(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, s] of this.sessions) if (s.updatedAt < cutoff) this.sessions.delete(k);
  }

  private evictOldest(): void {
    let oldest: string | undefined;
    let t = Infinity;
    for (const [k, s] of this.sessions) if (s.updatedAt < t) { t = s.updatedAt; oldest = k; }
    if (oldest) this.sessions.delete(oldest);
  }
}
