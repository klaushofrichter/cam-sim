import type { FlvTag } from './flv';

export type Stream = 'sub' | 'main';
// ext: the third live stream (the app's Balanced), on models that have one.
// FLV only: no RTSP path, no recordings (the camera records main and sub).
export type LiveStream = Stream | 'ext';

// Where the camera's pictures come from. Plan 1 has only fixture media;
// Library videos (src/media/library.ts) are prepared into the same files.
export interface MediaSource {
  snapshot(): Promise<Buffer>;
  liveFlv(stream: LiveStream): { header: Buffer; tags: FlvTag[] };
  durationMs(stream: LiveStream): number;
  clipPath(stream: Stream): string;
  clipSize(stream: Stream): number;
  // Drops parsed data kept for live streams (the video is no longer shown).
  release?(): void;
  // A sequence of videos: the id of the video playing now.
  currentId?(): string;
  // Where a new live reader joins: the clock position snapped down to the
  // last keyframe at or before it, in the live FLV's timeline.
  startMs?(stream: LiveStream): number;
  // ffmpeg input arguments replacing ['-i', clipPath(stream)].
  inputArgs?(stream: Stream): string[];
}
