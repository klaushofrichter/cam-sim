import type { FlvTag } from '../media/flv';
// The pipeline's live SD stream, for FLV clients.
export interface LiveSubSource {
  active(): boolean; // a process is running and has sent its config tags
  generation(): number; // increases on every (re)start
  header(): Buffer;
  configTags(): FlvTag[]; // script, video and audio sequence headers of this generation
  subscribe(fn: (t: FlvTag, gen: number) => void): () => void;
}
