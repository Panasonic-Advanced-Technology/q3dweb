import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferPointCloudFilename, parseCloudUrlOptions } from '../src/cloudUrlOptions';

describe('cloudUrlOptions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the first non-empty point cloud URL and filename aliases', () => {
    const options = parseCloudUrlOptions(new URLSearchParams({
      cloudUrl: '   ',
      pointCloudUrl: 'https://example.com/a.pcd',
      filename: ' ',
      fileName: 'alias.pcd',
    }));

    expect(options).toEqual({
      pointCloudUrl: 'https://example.com/a.pcd',
      filename: 'alias.pcd',
    });
  });

  it('supports fallback URL aliases and missing values', () => {
    expect(parseCloudUrlOptions(new URLSearchParams({ fileUrl: 'b.ply' })).pointCloudUrl).toBe('b.ply');
    expect(parseCloudUrlOptions(new URLSearchParams({ url: 'c.las' })).pointCloudUrl).toBe('c.las');
    expect(parseCloudUrlOptions(new URLSearchParams({ src: 'd.e57' })).pointCloudUrl).toBe('d.e57');
    expect(parseCloudUrlOptions(new URLSearchParams({ file: 'e.laz', name: 'e.laz' }))).toEqual({
      pointCloudUrl: 'e.laz',
      filename: 'e.laz',
    });
    expect(parseCloudUrlOptions(new URLSearchParams())).toEqual({
      pointCloudUrl: undefined,
      filename: undefined,
    });
  });

  it('infers filenames from relative, malformed, and undecodable URLs', () => {
    expect(inferPointCloudFilename('/clouds/tiny_ascii.pcd?token=1')).toBe('tiny_ascii.pcd');
    expect(inferPointCloudFilename('%%%/bad%zz.pcd?token=1')).toBe('bad%zz.pcd');
    expect(inferPointCloudFilename('https://example.com/')).toBeUndefined();
  });

  it('falls back to path parsing when URL construction fails', () => {
    vi.stubGlobal('location', { href: 'http://%' });

    expect(inferPointCloudFilename('clouds/raw%zz.pcd?token=1')).toBe('raw%zz.pcd');
    expect(inferPointCloudFilename('?token=1')).toBeUndefined();
  });
});