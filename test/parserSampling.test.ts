import { describe, expect, it } from 'vitest';
import {
  computePointSampleRatio,
  estimateSampledPointCount,
  LARGE_FILE_SAMPLING_THRESHOLD_BYTES,
} from '../src/parsers/sampling';
import {
  shouldDeferInitialMemoryCheck,
  shouldUseSingleBufferParser,
} from '../src/viewer/streamEngine';

describe('parser sampling policy', () => {
  it('keeps ratio 1 below point and source budgets', () => {
    expect(computePointSampleRatio(100, 1_000, LARGE_FILE_SAMPLING_THRESHOLD_BYTES)).toBe(1);
  });

  it('uses point count budget when visible points exceed max', () => {
    expect(computePointSampleRatio(2_001, 1_000, 0)).toBe(3);
    expect(estimateSampledPointCount(2_001, 3, 1_000)).toBe(667);
  });

  it('forces thinning when source file is larger than 2GiB', () => {
    expect(computePointSampleRatio(100, 1_000, LARGE_FILE_SAMPLING_THRESHOLD_BYTES + 1)).toBe(2);
    expect(computePointSampleRatio(100_000, 1_000, LARGE_FILE_SAMPLING_THRESHOLD_BYTES * 5)).toBe(100);
  });

  it('routes LAZ/E57 through parsers without eager memory checks', () => {
    expect(shouldDeferInitialMemoryCheck('laz')).toBe(true);
    expect(shouldDeferInitialMemoryCheck('e57')).toBe(true);
    expect(shouldUseSingleBufferParser('laz')).toBe(true);
    expect(shouldUseSingleBufferParser('e57')).toBe(false);
    expect(shouldUseSingleBufferParser('pcd')).toBe(false);
  });
});
