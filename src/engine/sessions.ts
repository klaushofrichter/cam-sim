import { randomBytes } from 'crypto';
import type { User } from '../config';
import type { Clock } from './clock';

const LEASE_S = 3600;
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
  private readonly baichuan = new Map<number, { user: User; ip: string }>();

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

  // HTTP sessions only (the state's activeSessions).
  count(): number {
    this.prune();
    return this.tokens.size;
  }

  // GetOnline: HTTP and Baichuan sessions, by session id, as on the camera.
  online() {
    this.prune();
    const row = (sessionId: number, s: { user: User; ip: string }) => ({ canbeDisconn: 0, ip: s.ip, level: s.user.level, sessionId, userName: s.user.name });
    const http = [...this.tokens.values()].map((s) => row(s.sessionId, s));
    const bc = [...this.baichuan].map(([sessionId, s]) => row(sessionId, s));
    return [...http, ...bc].sort((a, b) => a.sessionId - b.sessionId);
  }

  // Ends the sessions whose lease has run out.
  private prune(): void {
    const now = this.clock.now().getTime();
    for (const [t, s] of this.tokens) if (s.expiresAt <= now) this.tokens.delete(t);
  }

  // Baichuan (port 9000) sessions: one per logged-in TCP connection. They take
  // session ids from the same counter and show in GetOnline, but they are not
  // tokens: the connection ends them, not a lease, a logout or a revoke.
  openBaichuan(user: User, ip: string): number {
    const sessionId = this.nextId++;
    this.baichuan.set(sessionId, { user: { ...user }, ip });
    return sessionId;
  }

  closeBaichuan(sessionId: number): void {
    this.baichuan.delete(sessionId);
  }

  // A copy of the first user that matches (the Baichuan login compares hashes).
  findUser(match: (u: User) => boolean): User | undefined {
    const u = this.userList.find(match);
    return u && { ...u };
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
