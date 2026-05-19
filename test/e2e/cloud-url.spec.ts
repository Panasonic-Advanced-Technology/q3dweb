/// <reference types="node" />

import { test, expect } from '@playwright/test';
import { attachErrorSinks, getSettingsItemSelect, parsePointCount, readTestData, TESTDATA_POINT_COUNT, waitForPointCount } from './helpers';

test.describe('cloud URL mode', () => {
  test('loads a remote point cloud when cloudUrl is present', async ({ page }) => {
    const { pageErrors } = attachErrorSinks(page);
    const data = readTestData('tiny_ascii.pcd');

    await page.route('https://cdn.example.test/remote-cloud.pcd', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'content-type': 'application/octet-stream',
          'content-length': String(data.byteLength),
        },
        body: Buffer.from(data),
      });
    });

    await page.goto(`/?mode=cloud&cloudUrl=${encodeURIComponent('https://cdn.example.test/remote-cloud.pcd')}`);
    const label = await waitForPointCount(page, 20_000);

    expect(parsePointCount(label)).toBe(TESTDATA_POINT_COUNT);
    expect(await getSettingsItemSelect(page).inputValue()).toBe('cloud');
    expect(pageErrors).toEqual([]);
  });
});