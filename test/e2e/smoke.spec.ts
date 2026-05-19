import { test, expect } from '@playwright/test';
import { attachErrorSinks, getSettingsItemSelect } from './helpers';

test.describe('smoke', () => {
  test('app boots and exposes a WebGL canvas with no JS errors', async ({ page }) => {
    const { consoleErrors, pageErrors } = attachErrorSinks(page);
    await page.goto('/');
    const canvas = page.locator('#app canvas');
    await expect(canvas).toBeVisible();

    // Canvas has non-zero size.
    const box = await canvas.boundingBox();
    expect(box && box.width > 100 && box.height > 100).toBeTruthy();

    // WebGL context obtainable.
    const hasGL = await page.evaluate(() => {
      const c = document.querySelector('#app canvas') as HTMLCanvasElement | null;
      if (!c) return false;
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    });
    expect(hasGL).toBe(true);

    expect(pageErrors).toEqual([]);
    // Allow benign console errors from missing optional resources but fail on uncaught throws.
    expect(consoleErrors.filter((e) => /Uncaught|TypeError|ReferenceError/i.test(e))).toEqual([]);
  });

  test('settings panel is present on boot and can be toggled with M', async ({ page }) => {
    await page.goto('/');
    const title = page.locator('[data-role="settings-panel-title"]');
    await expect(title).toBeVisible();
    const panel = page.locator('[data-minimized]').first();

    await page.locator('#app').click({ position: { x: 500, y: 500 } });
    await page.keyboard.press('m');
    await expect(panel).toHaveAttribute('data-minimized', 'true');
    await expect(page.locator('[data-role="settings-minimize-button"]')).toHaveText('\u2699');

    await page.keyboard.press('m');
    await expect(panel).toHaveAttribute('data-minimized', 'false');
    await expect(title).toBeVisible();
  });

  test('main win settings are shown initially (bg color + center toggle)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Set background color:')).toBeVisible();
    await expect(page.locator('text=Show Center Point')).toBeVisible();
    await expect(page.locator('[data-role="settings-item-label"]')).toHaveText('Viewer Setting:');

    // Default selection is "main win(Viewer)".
    const select = getSettingsItemSelect(page);
    await expect(select).toHaveValue('__main_win__');
  });

  test('settings panel uses the refreshed material-style surface and controls', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);

    const style = await page.evaluate(() => {
      const panel = document.querySelector('[data-minimized]') as HTMLElement;
      const select = document.querySelector('[data-role="settings-item-select"]') as HTMLElement;
      const selectButton = document.querySelector('[data-role="settings-item-menu-button"]') as HTMLElement;
      const selectMenu = document.querySelector('[data-role="settings-item-select-menu"]') as HTMLElement;
      const input = document.querySelector('input[type="text"]') as HTMLElement;
      const toggle = document.querySelector('[data-role="settings-minimize-button"]') as HTMLElement;
      const title = document.querySelector('[data-role="settings-panel-title"]') as HTMLElement;
      const panelStyle = getComputedStyle(panel);
      const selectStyle = getComputedStyle(selectButton);
      const inputStyle = getComputedStyle(input);
      const titleStyle = getComputedStyle(title);
      return {
        materialTheme: document.documentElement.classList.contains('q3d-material-web-theme'),
        menuDefined: customElements.get('md-menu') !== undefined,
        menuItemDefined: customElements.get('md-menu-item') !== undefined,
        rippleDefined: customElements.get('md-ripple') !== undefined,
        toggleRipple: toggle.querySelector('md-ripple') !== null,
        selectRipple: selectButton.querySelector('md-ripple') !== null,
        panelClass: panel.classList.contains('q3d-settings-panel'),
        selectClass: select.classList.contains('q3d-setting-control'),
        selectButtonClass: selectButton.classList.contains('q3d-material-select-button'),
        selectMenuClass: selectMenu.classList.contains('q3d-material-menu'),
        inputClass: input.classList.contains('q3d-setting-control'),
        titleTypescale: title.classList.contains('md-typescale-title-medium'),
        panelBackground: panelStyle.backgroundColor,
        panelShadow: panelStyle.boxShadow,
        panelRadius: panelStyle.borderTopLeftRadius,
        titleFontSize: titleStyle.fontSize,
        selectHeight: selectStyle.minHeight,
        selectRadius: selectStyle.borderTopLeftRadius,
        inputHeight: inputStyle.minHeight,
      };
    });

    expect(style.materialTheme).toBe(true);
    expect(style.menuDefined).toBe(true);
    expect(style.menuItemDefined).toBe(true);
    expect(style.rippleDefined).toBe(true);
    expect(style.toggleRipple).toBe(true);
    expect(style.selectRipple).toBe(true);
    expect(style.panelClass).toBe(true);
    expect(style.selectClass).toBe(true);
    expect(style.selectButtonClass).toBe(true);
    expect(style.selectMenuClass).toBe(true);
    expect(style.inputClass).toBe(true);
    expect(style.titleTypescale).toBe(true);
    expect(style.panelBackground).toBe('rgba(18, 18, 18, 0.94)');
    expect(style.panelShadow).not.toBe('none');
    expect(style.panelRadius).toBe('24px');
    expect(style.titleFontSize).toBe('16px');
    expect(style.selectHeight).toBe('40px');
    expect(style.selectRadius).toBe('16px');
    expect(style.inputHeight).toBe('36px');
  });

  test('settings target selector opens a Material Web menu', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);

    await page.locator('[data-role="settings-item-menu-button"]').click();
    await expect(page.locator('md-menu-item[data-value="grid"]')).toBeVisible();
    await page.locator('md-menu-item[data-value="grid"]').click();

    await expect(getSettingsItemSelect(page)).toHaveValue('grid');
    await expect(page.getByText('Spacing:')).toBeVisible();
  });
});
