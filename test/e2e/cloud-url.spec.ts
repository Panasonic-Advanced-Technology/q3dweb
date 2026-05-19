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

    const params = new URLSearchParams({
      mode: 'cloud',
      cloudUrl: 'https://cdn.example.test/remote-cloud.pcd',
      maxPoints: '12345',
      pointSize: '7',
      pointType: 'sphere',
      alpha: '0.35',
      colorMode: 'flat',
      vmin: '-5',
      vmax: '250',
      bgColor: '#112233',
      showCenter: 'false',
    });

    await page.goto(`/?${params.toString()}`);
    const label = await waitForPointCount(page, 20_000);

    expect(parsePointCount(label)).toBe(TESTDATA_POINT_COUNT);
    expect(await getSettingsItemSelect(page).inputValue()).toBe('cloud');
    const appliedOptions = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const material = viewer.items.cloud.material;
      return {
        maxPoints: viewer.MAX_POINTS_VISUAL,
        background: viewer.scene.background.getHexString(),
        showCenter: viewer.enableShowCenter,
        pointSize: material.uniforms.pointSize.value,
        pointType: material.uniforms.pointType.value,
        alpha: material.uniforms.alpha.value,
        colorMode: material.uniforms.colorMode.value,
        vmin: material.uniforms.vmin.value,
        vmax: material.uniforms.vmax.value,
      };
    });
    expect(appliedOptions).toEqual({
      maxPoints: 12345,
      background: '112233',
      showCenter: false,
      pointSize: 7,
      pointType: 2,
      alpha: 0.35,
      colorMode: 2,
      vmin: -5,
      vmax: 250,
    });
    expect(pageErrors).toEqual([]);
  });
});