// The SDP a DESCRIBE answers, shaped like the model's (profile.rtsp):
// MediaMTX writes sprop-parameter-sets (H.264) or sprop-vps/sps/pps (H.265)
// into every video track's fmtp line once it has seen the parameter sets;
// the E1 Outdoor Pro and the RLC-1224A send no fmtp line for video at all
// (measured 2026-11-02), so a client gets the parameter sets in band only.
// Pure: no I/O.

export interface SdpShape { sprop: boolean; tool?: string }

export function shapeSdp(sdp: string, shape: SdpShape): string {
  if (shape.sprop && !shape.tool) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const out: string[] = [];
  let media: string | null = null; // the m= section's kind; null: session level
  for (const line of lines) {
    if (line.startsWith('m=')) media = line.slice(2).split(' ')[0];
    if (!shape.sprop && media === 'video' && line.startsWith('a=fmtp:')) continue;
    out.push(line);
    // The tool line at session level, after t= (as the camera's).
    if (shape.tool && media === null && line.startsWith('t=')) out.push(`a=tool:${shape.tool}`);
  }
  return out.join(eol);
}
