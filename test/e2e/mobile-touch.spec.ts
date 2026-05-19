import { test, expect } from '@playwright/test';
import { attachErrorSinks } from './helpers';

test.describe('mobile touch operation', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('minimizes the settings menu with a tap and keeps the compact button borderless', async ({ page }) => {
    const { pageErrors } = attachErrorSinks(page);
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);

    const button = page.locator('[data-role="settings-minimize-button"]');
    await button.tap();
    await expect(page.locator('[data-minimized]').first()).toHaveAttribute('data-minimized', 'true');
    await expect(button).toHaveText('+');

    const minimizedStyle = await page.evaluate(() => {
      const panel = document.querySelector('[data-minimized]') as HTMLElement;
      const toggle = document.querySelector('[data-role="settings-minimize-button"]') as HTMLElement;
      const panelStyle = getComputedStyle(panel);
      const toggleStyle = getComputedStyle(toggle);
      return {
        panelBorder: panelStyle.borderTopWidth,
        panelBackground: panelStyle.backgroundColor,
        toggleBorder: toggleStyle.borderTopWidth,
      };
    });
    expect(minimizedStyle.panelBorder).toBe('0px');
    expect(minimizedStyle.panelBackground).toBe('rgba(0, 0, 0, 0)');
    expect(minimizedStyle.toggleBorder).toBe('0px');

    await button.tap();
    await expect(page.locator('[data-minimized]').first()).toHaveAttribute('data-minimized', 'false');
    await expect(button).toHaveText('-');
    expect(pageErrors).toEqual([]);
  });

  test('one-finger pan and two-finger rotate/pinch update the camera without measurement mode', async ({ page }) => {
    const { pageErrors } = attachErrorSinks(page);
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);

    const result = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const canvas = viewer.renderer.domElement as HTMLCanvasElement;
      (canvas as any).setPointerCapture = () => undefined;
      const dispatchPointer = (type: string, pointerId: number, x: number, y: number, buttons: number) => {
        canvas.dispatchEvent(new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: pointerId === 1,
          clientX: x,
          clientY: y,
          buttons,
          bubbles: true,
          cancelable: true,
        }));
      };

      const beforeCenter = viewer.cameraCenter.clone();
      dispatchPointer('pointerdown', 1, 100, 100, 1);
      dispatchPointer('pointermove', 1, 145, 130, 1);
      dispatchPointer('pointerup', 1, 145, 130, 0);
      const panDistance = viewer.cameraCenter.distanceTo(beforeCenter);

      const beforeEuler = [...viewer.euler];
      const beforeDistance = viewer.cameraDist;
      dispatchPointer('pointerdown', 1, 100, 100, 1);
      dispatchPointer('pointerdown', 2, 200, 100, 1);
      dispatchPointer('pointermove', 1, 120, 120, 1);
      dispatchPointer('pointermove', 2, 245, 120, 1);
      dispatchPointer('pointerup', 1, 120, 120, 0);
      dispatchPointer('pointerup', 2, 245, 120, 0);

      const eulerDelta = Math.max(
        Math.abs(viewer.euler[0] - beforeEuler[0]),
        Math.abs(viewer.euler[1] - beforeEuler[1]),
        Math.abs(viewer.euler[2] - beforeEuler[2]),
      );

      return {
        isTouchPrimaryDevice: viewer.isTouchPrimaryDevice,
        panDistance,
        eulerDelta,
        distanceDelta: Math.abs(viewer.cameraDist - beforeDistance),
        selectedPointCount: viewer.selectedPoints.length,
      };
    });

    expect(result.isTouchPrimaryDevice).toBe(true);
    expect(result.panDistance).toBeGreaterThan(0);
    expect(result.eulerDelta).toBeGreaterThan(0.1);
    expect(result.distanceDelta).toBeGreaterThan(0);
    expect(result.selectedPointCount).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});