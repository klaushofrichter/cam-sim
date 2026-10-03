// Event and recording trigger types, as encoded in the firmware's file names.
export type Trigger = 'motion' | 'person' | 'vehicle' | 'pet';
export const TRIGGERS: readonly Trigger[] = ['motion', 'person', 'vehicle', 'pet'];

// Schedule table key per trigger type (Rec and Ftp schedule.table).
const SCHEDULE_KEY: Record<Trigger, string> = { motion: 'MD', person: 'AI_PEOPLE', vehicle: 'AI_VEHICLE', pet: 'AI_DOG_CAT' };

// Whether a schedule table allows `trigger` in an hour of the week (weekday 0 = Sunday).
export function scheduled(table: Record<string, unknown> | undefined, trigger: Trigger, weekday: number, hour: number): boolean {
  return String(table?.[SCHEDULE_KEY[trigger]] ?? '')[weekday * 24 + hour] === '1';
}

// Validation patterns for the dates and times the control API and the SD index take.
export const HMS = /^([01]\d|2[0-3])[0-5]\d[0-5]\d$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
