import type { FlvTag } from './flv';

export type Stream = 'sub' | 'main';

// Where the camera's pictures come from. Plan 1 has only fixture media;
// Plan 2 adds live video from the library.
export interface MediaSource {
  snapshot(): Promise<Buffer>;
  liveFlv(stream: Stream): { header: Buffer; tags: FlvTag[] };
  durationMs(stream: Stream): number;
  clipPath(stream: Stream): string;
  clipSize(stream: Stream): number;
}
