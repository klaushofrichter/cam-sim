import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findFonts } from '../src/pipeline/fonts';

describe('findFonts', () => {
  it('uses CAMSIM_FONT_DIR when it has DejaVu Sans and Bold', () => {
    const d = mkdtempSync(join(tmpdir(), 'fonts-'));
    writeFileSync(join(d, 'DejaVuSans.ttf'), 'x');
    writeFileSync(join(d, 'DejaVuSans-Bold.ttf'), 'x');
    expect(findFonts(d)).toEqual({ regular: join(d, 'DejaVuSans.ttf'), bold: join(d, 'DejaVuSans-Bold.ttf') });
  });

  it('answers null for a folder without the fonts', () => {
    expect(findFonts(mkdtempSync(join(tmpdir(), 'nofonts-')))).toBeNull();
  });

  it('finds system fonts on this machine (Alpine, Debian/Ubuntu or macOS)', () => {
    const f = findFonts();
    expect(f?.regular).toMatch(/\.ttf$/);
    expect(f?.bold).toMatch(/\.ttf$/);
  });
});
