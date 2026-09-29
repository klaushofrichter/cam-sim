import { existsSync } from 'fs';
import { join } from 'path';

// The SD pipeline's fonts: DejaVu Sans (the container's font-dejavu, or
// Debian/Ubuntu's fonts-dejavu-core), or Arial on a Mac for development.
const CANDIDATES: Array<[string, string, string]> = [
  ['/usr/share/fonts/dejavu', 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/dejavu', 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'],
  ['/System/Library/Fonts/Supplemental', 'Arial.ttf', 'Arial Bold.ttf'],
];

export function findFonts(dir?: string): { regular: string; bold: string } | null {
  const list: Array<[string, string, string]> = dir ? [[dir, 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']] : CANDIDATES;
  for (const [d, r, b] of list) {
    const regular = join(d, r), bold = join(d, b);
    if (existsSync(regular) && existsSync(bold)) return { regular, bold };
  }
  return null;
}
