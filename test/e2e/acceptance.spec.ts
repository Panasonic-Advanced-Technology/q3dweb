import { test, expect } from '@playwright/test';
import {
  attachErrorSinks,
  dropFile,
  getCloudSizeInput,
  getCloudSizeLabel,
  getSettingsItemSelect,
  readTestData,
  waitForPointCount,
  parsePointCount,
  TESTDATA_POINT_COUNT,
} from './helpers';

/**
 * Acceptance test: the end-to-end happy path a real user would follow.
 * Boot → drop a real sample PCD → open per-item settings → tweak size → zoom → measure.
 * The whole flow must complete without any uncaught JS errors.
 */
test.describe('acceptance', () => {
  test('real user happy path with tiny_ascii.pcd', async ({ page }) => {
    const { pageErrors } = attachErrorSinks(page);

    await page.goto('/');
    await expect(page.locator('#app canvas')).toBeVisible();

    // 1. Load the minimal sample fixture from test/e2e/testdata/.
    await dropFile(page, 'tiny_ascii.pcd', readTestData('tiny_ascii.pcd'));
    const label = await waitForPointCount(page);
    const n = parsePointCount(label);
    expect(n).toBe(TESTDATA_POINT_COUNT);

    // 2. Cloud item is auto-selected in the settings combo.
    const select = getSettingsItemSelect(page);
    await expect(select).toHaveValue('cloud');
    await expect(getCloudSizeLabel(page)).toBeVisible();

    // 3. Bump the point size.
    const sizeInput = getCloudSizeInput(page);
    await sizeInput.fill('6');
    await sizeInput.press('Enter');

    // 4. Zoom in a few notches.
    const box = (await page.locator('#app canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -150);

    // 5. Toggle settings panel with M and back.
    await page.locator('#app').click({ position: { x: box.width - 20, y: box.height - 20 } });
    await page.keyboard.press('m');
    await expect(page.locator('[data-minimized]').first()).toHaveAttribute('data-minimized', 'true');
    await page.keyboard.press('m');
    await expect(page.locator('[data-minimized]').first()).toHaveAttribute('data-minimized', 'false');

    // 6. Ctrl+click measurement. We do not assert overlay presence (depends on ray hit),
    //    only that the app is still healthy.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.keyboard.down('Control');
    await page.mouse.click(cx - 30, cy);
    await page.mouse.click(cx + 30, cy);
    await page.keyboard.up('Control');

    // 7. Final health checks.
    await expect(page.locator('#app canvas')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
