import { EventEmitter } from 'events';

// Faults a test switches on through the control API (never the camera API).
// Each is on until cleared, or for the next `count` matching requests.
export const FAULT_NAMES = [
  'downloads.refuse', 'downloads.dropFirst', 'downloads.dropMidway', 'downloads.delayMs',
  'flv.reset', 'flv.delayMs', 'search.delayMs',
  'settings.fail', 'settings.ignore', 'settings.strictPartial',
  'offline', 'latencyMs', 'snap.fail',
  'ftp.fail', 'ftp.delayMs',
] as const;
export type FaultName = (typeof FAULT_NAMES)[number];

// One-shot actions, applied at once rather than kept.
export const ACTION_NAMES = ['tokens.revoke', 'reboot', 'power-off', 'power-on', 'flv.dropActive', 'downloads.dropActive'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export interface FaultSpec {
  name: FaultName;
  count?: number;
  ms?: number;
  cmds?: string[];
  rspCode?: number;
}

const NEEDS_MS: FaultName[] = ['downloads.delayMs', 'flv.delayMs', 'search.delayMs', 'latencyMs', 'ftp.delayMs'];
const NEEDS_CMDS: FaultName[] = ['settings.fail', 'settings.ignore'];

export class FaultError extends Error {}

export class Faults extends EventEmitter {
  private readonly faults = new Map<FaultName, FaultSpec>();

  set(spec: FaultSpec): void {
    const name = spec?.name;
    if (!(FAULT_NAMES as readonly string[]).includes(name)) throw new FaultError(`unknown fault: ${String(name)}`);
    if (spec.count !== undefined && !(Number.isInteger(spec.count) && spec.count > 0)) throw new FaultError('count must be a positive integer');
    if (name === 'downloads.dropFirst' && spec.count === undefined) throw new FaultError('downloads.dropFirst needs a count');
    if (NEEDS_MS.includes(name) && !(Number.isInteger(spec.ms) && (spec.ms as number) >= 0)) throw new FaultError(`${name} needs ms`);
    if (NEEDS_CMDS.includes(name) && !(Array.isArray(spec.cmds) && spec.cmds.length && spec.cmds.every((c) => typeof c === 'string'))) {
      throw new FaultError(`${name} needs cmds`);
    }
    const clean: FaultSpec = { name };
    if (spec.count !== undefined) clean.count = spec.count;
    if (spec.ms !== undefined) clean.ms = spec.ms;
    if (spec.cmds) clean.cmds = [...spec.cmds];
    if (name === 'settings.fail') clean.rspCode = Number.isInteger(spec.rspCode) ? spec.rspCode : -67;
    this.faults.set(name, clean);
    this.emit('change');
  }

  clear(name: FaultName): void {
    if (this.faults.delete(name)) this.emit('change');
  }

  clearAll(): void {
    this.faults.clear();
    this.emit('change');
  }

  list(): FaultSpec[] {
    return [...this.faults.values()].map((f) => ({ ...f }));
  }

  active(name: FaultName): FaultSpec | undefined {
    return this.faults.get(name);
  }

  // Active and applying to this command (settings faults).
  activeFor(name: FaultName, cmd: string): FaultSpec | undefined {
    const f = this.faults.get(name);
    return f && (!f.cmds || f.cmds.includes(cmd)) ? f : undefined;
  }

  // Uses up one application of a next-N fault; on-faults stay.
  consume(name: FaultName, cmd?: string): FaultSpec | undefined {
    const f = cmd === undefined ? this.faults.get(name) : this.activeFor(name, cmd);
    if (!f) return undefined;
    if (f.count !== undefined) {
      f.count -= 1;
      if (f.count <= 0) this.faults.delete(name);
      this.emit('change');
    }
    return { ...f };
  }
}
