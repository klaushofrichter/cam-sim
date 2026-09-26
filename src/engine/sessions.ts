import { randomBytes } from 'crypto';
import type { User } from '../config';
import type { Clock } from './clock';

export const LEASE_S = 3600;
// The first session id the real camera handed out after a restart.
const FIRST_SESSION_ID = 10;

export interface SessionInfo {
  user: User;
  ip: string;
  sessionId: number;
  expiresAt: number;
}

export type LoginResult = { ok: true; token: string; leaseTime: number } | { ok: false; rspCode: number };

// Camera users and login sessions. Like the firmware, sessions that are never
// logged out pile up until their lease ends; there is no cap.
export class Sessions {
  private readonly userList: User[];
  private readonly tokens = new Map<string, SessionInfo>();
  private nextId = FIRST_SESSION_ID;

  constructor(users: User[], private readonly clock: Clock) {
    this.userList = users.map((u) => ({ ...u }));
  }

  login(userName: string, password: string, ip: string): LoginResult {
    const user = this.userList.find((u) => u.name === userName);
    if (!user || user.password !== password) return { ok: false, rspCode: -7 };
    const token = randomBytes(8).toString('hex');
    this.tokens.set(token, { user, ip, sessionId: this.nextId++, expiresAt: this.clock.now().getTime() + LEASE_S * 1000 });
    return { ok: true, token, leaseTime: LEASE_S };
  }

  validate(token: string | undefined): SessionInfo | undefined {
    if (!token) return undefined;
    const s = this.tokens.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= this.clock.now().getTime()) {
      this.tokens.delete(token);
      return undefined;
    }
    return s;
  }

  logout(token: string): void {
    this.tokens.delete(token);
  }

  revokeAll(): void {
    this.tokens.clear();
  }

  revokeUser(name: string): void {
    for (const [t, s] of this.tokens) if (s.user.name === name) this.tokens.delete(t);
  }

  count(): number {
    return this.online().length;
  }

  online() {
    const now = this.clock.now().getTime();
    const out = [];
    for (const [t, s] of this.tokens) {
      if (s.expiresAt <= now) {
        this.tokens.delete(t);
        continue;
      }
      out.push({ canbeDisconn: 0, ip: s.ip, level: s.user.level, sessionId: s.sessionId, userName: s.user.name });
    }
    return out;
  }

  users() {
    return this.userList.map((u) => ({ level: u.level, userName: u.name }));
  }

  // Error codes: the firmware's generic -4 ("param error"); the camera's
  // specific codes for these cases were not measured.
  addUser(u: User): number | null {
    if (!u.name || !u.password || (u.level !== 'admin' && u.level !== 'guest')) return -4;
    if (this.userList.some((x) => x.name === u.name)) return -4;
    this.userList.push({ ...u });
    return null;
  }

  delUser(name: string): number | null {
    const i = this.userList.findIndex((u) => u.name === name);
    if (i < 0) return -4;
    this.userList.splice(i, 1);
    this.revokeUser(name);
    return null;
  }

  modifyUser(name: string, patch: { password?: string; level?: string }): number | null {
    const u = this.userList.find((x) => x.name === name);
    if (!u) return -4;
    if (patch.level !== undefined) {
      if (patch.level !== 'admin' && patch.level !== 'guest') return -4;
      u.level = patch.level;
    }
    if (patch.password !== undefined) {
      if (!patch.password) return -4;
      u.password = patch.password;
      this.revokeUser(name);
    }
    return null;
  }
}
