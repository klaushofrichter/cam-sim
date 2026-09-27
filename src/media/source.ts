import type { FlvTag } from './flv';

export type Stream = 'sub' | 'main';

// Where the camera's pictures come from. Plan 1 has only fixture media;
// Library videos (src/media/library.ts) are prepared into the same files.
export interface MediaSource {
  snapshot(): Promise<Buffer>;
  liveFlv(stream: Stream): { header: Buffer; tags: FlvTag[] };
  durationMs(stream: Stream): number;
  clipPath(stream: Stream): string;
  clipSize(stream: Stream): number;
}
