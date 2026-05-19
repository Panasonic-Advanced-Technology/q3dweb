import { test, expect } from '@playwright/test';
import { dropFile, getCloudSizeInput, getCloudSizeLabel, getSettingsItemSelect, makeAsciiPLY, waitForPointCount } from './helpers';

test.describe('settings panel', () => {
  test('background color input updates scene.background', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);

    const colorInput = page
      .locator('text=Set background color:')
      .locator('..')
      .locator('input[type="text"]');
    await expect(colorInput).toBeVisible();

    await colorInput.fill('#ff0000');
    await colorInput.press('Enter');
    await colorInput.blur();

    const hex = await page.evaluate(() => {
      const v = (window as any).__viewer;
      return v.scene.background?.getHexString?.() ?? '';
    });
    expect(hex).toBe('ff0000');

    await colorInput.fill('#00ff00');
    await colorInput.press('Enter');
    await colorInput.blur();
    const hex2 = await page.evaluate(() =>
      (window as any).__viewer.scene.background.getHexString(),
    );
    expect(hex2).toBe('00ff00');
  });

  test('loading a cloud adds a "cloud" option and exposes per-item controls', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);
    await dropFile(page, 'synth.ply', makeAsciiPLY(1234));
    await waitForPointCount(page);

    const select = getSettingsItemSelect(page);
    await expect(select).toHaveValue('cloud');
    const optionValues = await select.locator('option').evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLOptionElement).value),
    );
    expect(optionValues).toContain('cloud');

    await expect(page.locator('text=Points:')).toBeVisible();
    await expect(getCloudSizeLabel(page)).toBeVisible();
    await expect(page.locator('text=1,234 pts')).toBeVisible();
  });

  test('changing point size updates the material uniform', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);
    await dropFile(page, 'synth.ply', makeAsciiPLY(500));
    await waitForPointCount(page);

    const sizeInput = getCloudSizeInput(page);
    await expect(sizeInput).toBeVisible();

    await sizeInput.fill('8');
    await sizeInput.press('Enter');
    await sizeInput.blur();

    const uniformSize = await page.evaluate(() => {
      const v = (window as any).__viewer;
      const dpr = window.devicePixelRatio;
      return v.items.cloud.material.uniforms.pointSize.value / dpr;
    });
    expect(uniformSize).toBeCloseTo(8, 1);

    await expect(page.locator('#app canvas')).toBeVisible();
  });
});
