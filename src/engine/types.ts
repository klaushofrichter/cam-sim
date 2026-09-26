// Event and recording trigger types, as encoded in the firmware's file names.
export type Trigger = 'motion' | 'person' | 'vehicle' | 'pet';
export const TRIGGERS: readonly Trigger[] = ['motion', 'person', 'vehicle', 'pet'];
