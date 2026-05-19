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

  test('one-finger pan and two-finger twist/pitch rotate update the camera without measurement mode', async ({ page }) => {
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
      dispatchPointer('pointermove', 1, 120, 80, 1);
      dispatchPointer('pointermove', 2, 245, 145, 1);
      dispatchPointer('pointerup', 1, 120, 80, 0);
      dispatchPointer('pointerup', 2, 245, 145, 0);

      const twistYawDelta = viewer.euler[2] - beforeEuler[2];

      const beforeParallelEuler = [...viewer.euler];
      const beforeParallelDistance = viewer.cameraDist;
      dispatchPointer('pointerdown', 1, 100, 180, 1);
      dispatchPointer('pointerdown', 2, 220, 180, 1);
      dispatchPointer('pointermove', 1, 100, 120, 1);
      dispatchPointer('pointermove', 2, 220, 120, 1);
      dispatchPointer('pointerup', 1, 100, 120, 0);
      dispatchPointer('pointerup', 2, 220, 120, 0);

      const parallelPitchDelta = viewer.euler[0] - beforeParallelEuler[0];
      const parallelYawDelta = Math.abs(viewer.euler[2] - beforeParallelEuler[2]);
        const parallelDistanceDelta = Math.abs(viewer.cameraDist - beforeParallelDistance);

      return {
        isTouchPrimaryDevice: viewer.isTouchPrimaryDevice,
        panDistance,
        twistYawDelta,
        parallelPitchDelta,
        parallelYawDelta,
        parallelDistanceDelta,
        distanceDelta: Math.abs(viewer.cameraDist - beforeDistance),
        selectedPointCount: viewer.selectedPoints.length,
      };
    });

    expect(result.isTouchPrimaryDevice).toBe(true);
    expect(result.panDistance).toBeGreaterThan(0);
    expect(result.twistYawDelta).toBeGreaterThan(0.1);
    expect(result.parallelPitchDelta).toBeGreaterThan(0.1);
    expect(result.parallelYawDelta).toBeLessThan(0.01);
    expect(result.parallelDistanceDelta).toBeLessThan(0.01);
    expect(result.distanceDelta).toBeGreaterThan(0);
    expect(result.selectedPointCount).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});