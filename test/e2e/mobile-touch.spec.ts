import { test, expect } from '@playwright/test';
import { attachErrorSinks } from './helpers';

test.describe('mobile touch operation', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('disables browser page zoom on mobile viewports', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);

    const state = await page.evaluate(() => {
      const viewport = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
      const htmlStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      const appStyle = getComputedStyle(document.getElementById('app') as HTMLElement);
      return {
        viewport: viewport?.content ?? '',
        htmlTouchAction: htmlStyle.touchAction,
        bodyTouchAction: bodyStyle.touchAction,
        appTouchAction: appStyle.touchAction,
        bodyOverscroll: bodyStyle.overscrollBehavior,
      };
    });

    expect(state.viewport).toContain('maximum-scale=1.0');
    expect(state.viewport).toContain('user-scalable=no');
    expect(state.viewport).toContain('viewport-fit=cover');
    expect(state.htmlTouchAction).toBe('none');
    expect(state.bodyTouchAction).toBe('none');
    expect(state.appTouchAction).toBe('none');
    expect(state.bodyOverscroll).toBe('none');
  });

  test('minimizes the settings menu with a tap and keeps the compact button as a round M3 icon button', async ({ page }) => {
    const { pageErrors } = attachErrorSinks(page);
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__viewer);

    const button = page.locator('[data-role="settings-minimize-button"]');
    await button.tap();
    await expect(page.locator('[data-minimized]').first()).toHaveAttribute('data-minimized', 'true');
    await expect(button).toHaveText('\u2699');

    const minimizedStyle = await page.evaluate(() => {
      const panel = document.querySelector('[data-minimized]') as HTMLElement;
      const toggle = document.querySelector('[data-role="settings-minimize-button"]') as HTMLElement;
      const panelStyle = getComputedStyle(panel);
      const toggleStyle = getComputedStyle(toggle);
      return {
        panelBorder: panelStyle.borderTopWidth,
        panelBackground: panelStyle.backgroundColor,
        toggleBorder: toggleStyle.borderTopWidth,
        toggleBorderRadius: toggleStyle.borderTopLeftRadius,
        toggleWidth: toggleStyle.width,
        toggleHeight: toggleStyle.height,
      };
    });
    expect(minimizedStyle.panelBorder).toBe('0px');
    expect(minimizedStyle.panelBackground).toBe('rgba(0, 0, 0, 0)');
    expect(minimizedStyle.toggleBorder).toBe('1px');
    expect(minimizedStyle.toggleBorderRadius).toBe('999px');
    expect(minimizedStyle.toggleWidth).toBe('36px');
    expect(minimizedStyle.toggleHeight).toBe('36px');

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

      const beforePinchCenter = viewer.cameraCenter.clone();
      const beforePinchDistance = viewer.cameraDist;
      dispatchPointer('pointerdown', 1, 100, 100, 1);
      dispatchPointer('pointerdown', 2, 200, 100, 1);
      dispatchPointer('pointermove', 1, 80, 100, 1);
      dispatchPointer('pointermove', 2, 220, 100, 1);
      dispatchPointer('pointerup', 1, 80, 100, 0);
      dispatchPointer('pointermove', 2, 260, 160, 1);
      dispatchPointer('pointerup', 2, 260, 160, 0);

      const pinchCenterDelta = viewer.cameraCenter.distanceTo(beforePinchCenter);
      const pinchDistanceDelta = Math.abs(viewer.cameraDist - beforePinchDistance);

      const beforeParallelEuler = [...viewer.euler];
      const beforeParallelDistance = viewer.cameraDist;
      const beforeParallelCenterDistance = viewer.camera.position.distanceTo(viewer.cameraCenter);
      dispatchPointer('pointerdown', 1, 100, 180, 1);
      dispatchPointer('pointerdown', 2, 220, 180, 1);
      dispatchPointer('pointermove', 1, 100, 60, 1);
      dispatchPointer('pointermove', 2, 220, 60, 1);
      dispatchPointer('pointerup', 1, 100, 60, 0);
      dispatchPointer('pointerup', 2, 220, 60, 0);

      const parallelPitchDelta = viewer.euler[0] - beforeParallelEuler[0];
      const parallelYawDelta = Math.abs(viewer.euler[2] - beforeParallelEuler[2]);
      const parallelDistanceDelta = Math.abs(viewer.cameraDist - beforeParallelDistance);
      const parallelCenterDistanceDelta = Math.abs(viewer.camera.position.distanceTo(viewer.cameraCenter) - beforeParallelCenterDistance);

      return {
        isTouchPrimaryDevice: viewer.isTouchPrimaryDevice,
        panDistance,
        twistYawDelta,
        pinchCenterDelta,
        pinchDistanceDelta,
        parallelPitchDelta,
        parallelYawDelta,
        parallelDistanceDelta,
        parallelCenterDistanceDelta,
        distanceDelta: Math.abs(viewer.cameraDist - beforeDistance),
        selectedPointCount: viewer.selectedPoints.length,
      };
    });

    expect(result.isTouchPrimaryDevice).toBe(true);
    expect(result.panDistance).toBeGreaterThan(0);
    expect(result.twistYawDelta).toBeGreaterThan(0.1);
    expect(result.pinchDistanceDelta).toBeGreaterThan(0);
    expect(result.pinchCenterDelta).toBeLessThan(0.01);
    expect(result.parallelPitchDelta).toBeGreaterThan(0.08);
    expect(result.parallelYawDelta).toBeLessThan(0.01);
    expect(result.parallelDistanceDelta).toBeLessThan(0.01);
    expect(result.parallelCenterDistanceDelta).toBeLessThan(0.01);
    expect(result.distanceDelta).toBeGreaterThan(0);
    expect(result.selectedPointCount).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test('two-finger pitch amount stays constant across zoom levels', async ({ page }) => {
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

      const runPitchAtDistance = (cameraDist: number) => {
        viewer.cameraCenter.set(0, 0, 0);
        viewer.cameraDist = cameraDist;
        viewer.euler = [Math.PI / 3, 0, 0];
        viewer.updateCamera();

        const beforePitch = viewer.euler[0];
        dispatchPointer('pointerdown', 1, 100, 180, 1);
        dispatchPointer('pointerdown', 2, 220, 180, 1);
        dispatchPointer('pointermove', 1, 100, 140, 1);
        dispatchPointer('pointermove', 2, 220, 140, 1);
        dispatchPointer('pointerup', 1, 100, 140, 0);
        dispatchPointer('pointerup', 2, 220, 140, 0);
        return viewer.euler[0] - beforePitch;
      };

      return {
        nearPitchDelta: runPitchAtDistance(10),
        farPitchDelta: runPitchAtDistance(80),
      };
    });

    expect(result.nearPitchDelta).toBeGreaterThan(0);
    expect(result.farPitchDelta).toBeCloseTo(result.nearPitchDelta, 6);
    expect(pageErrors).toEqual([]);
  });
});