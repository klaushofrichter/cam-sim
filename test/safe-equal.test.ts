import { describe, it, expect } from 'vitest';
import { safeEqual } from '../src/util/safe-equal';

describe('safeEqual', () => {
  it('compares exactly', () => {
    expect(safeEqual('s3cret', 's3cret')).toBe(true);
    expect(safeEqual('s3cret', 's3creT')).toBe(false);
    expect(safeEqual('s3cret', 's3cret!')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('ü', 'u')).toBe(false);
  });
});
