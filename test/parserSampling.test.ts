import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureSamplingHeapBudget,
  computePointSampleRatio,
  estimateSampledPointCount,
  getLargeFileSamplingThresholdBytes,
} from '../src/parsers/sampling';
import {
  shouldDeferInitialMemoryCheck,
  shouldUseSingleBufferParser,
} from '../src/viewer/streamEngine';

describe('parser sampling policy', () => {
  beforeEach(() => {
    configureSamplingHeapBudget(4 * 1024 * 1024 * 1024, 0);
  });

  afterEach(() => {
    configureSamplingHeapBudget(undefined, undefined);
  });

  it('keeps ratio 1 below point and source budgets', () => {
    expect(getLargeFileSamplingThresholdBytes()).toBe(2 * 1024 * 1024 * 1024);
    expect(computePointSampleRatio(100, 1_000, getLargeFileSamplingThresholdBytes())).toBe(1);
  });

  it('uses point count budget when visible points exceed max', () => {
    expect(computePointSampleRatio(2_001, 1_000, 0)).toBe(3);
    expect(estimateSampledPointCount(2_001, 3, 1_000)).toBe(667);
  });

  it('forces thinning when source file is larger than 2GiB', () => {
    const threshold = getLargeFileSamplingThresholdBytes();
    expect(computePointSampleRatio(100, 1_000, threshold + 1)).toBe(2);
    expect(computePointSampleRatio(100_000, 1_000, threshold * 5)).toBe(100);
  });

  it('derives source-size threshold from available heap', () => {
    configureSamplingHeapBudget(1024 * 1024 * 1024, 256 * 1024 * 1024);
    const threshold = getLargeFileSamplingThresholdBytes();
    expect(threshold).toBe(384 * 1024 * 1024);
    expect(computePointSampleRatio(100, 1_000, threshold + 1)).toBe(2);
  });

  it('routes LAZ/E57 through parsers without eager memory checks', () => {
    expect(shouldDeferInitialMemoryCheck('laz')).toBe(true);
    expect(shouldDeferInitialMemoryCheck('e57')).toBe(true);
    expect(shouldUseSingleBufferParser('laz')).toBe(true);
    expect(shouldUseSingleBufferParser('e57')).toBe(false);
    expect(shouldUseSingleBufferParser('pcd')).toBe(false);
  });
});
