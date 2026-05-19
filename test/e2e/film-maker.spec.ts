import { test, expect } from '@playwright/test';
import { dropFile, makeAsciiPLY, waitForPointCount, attachErrorSinks } from './helpers';

test.describe('film maker mode', () => {
  test('renders Film Maker controls in the viewer mode', async ({ page }) => {
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);

    await expect(page.locator('[data-role="viewer-mode-select"]')).toHaveValue('film_maker');
    await expect(page.locator('[data-role="film-maker"]')).toBeVisible();
    await expect(page.locator('text=Add Key Frame (Space)')).toBeVisible();
    await expect(page.locator('text=Delete Key Frame (Delete)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    await expect(page.getByText('Record', { exact: true })).toBeVisible();
    await expect(page.locator('text=Video File Name:')).toBeVisible();
  });

  test('Space adds a key frame when the tab is active; button also adds', async ({ page }) => {
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);

    // Focus the canvas so window key handler fires (not any input).
    await page.locator('#app canvas').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await expect(page.locator('text=Frame 1')).toBeVisible();
    await expect(page.locator('text=Frame 2')).toBeVisible();

    // Button also works.
    await page.getByRole('button', { name: 'Add Key Frame (Space)' }).click();
    await expect(page.locator('text=Frame 3')).toBeVisible();

    const count = await page.evaluate(() => (window as any).__viewer.filmMaker.keyFrames.length);
    expect(count).toBe(3);
  });

  test('Delete removes the selected key frame', async ({ page }) => {
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);
    await page.locator('#app canvas').click({ position: { x: 400, y: 300 } });

    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await expect(page.locator('text=Frame 3')).toBeVisible();

    await page.keyboard.press('Delete');
    await expect(page.locator('text=Frame 3')).toHaveCount(0);
    const count = await page.evaluate(() => (window as any).__viewer.filmMaker.keyFrames.length);
    expect(count).toBe(2);
  });

  test('cloud mode does not expose Film Maker shortcuts or state', async ({ page }) => {
    await page.goto('/?mode=cloud');
    await page.waitForFunction(() => (window as any).__viewer);
    await page.locator('#app canvas').click({ position: { x: 400, y: 300 } });
    await page.keyboard.press('Space');
    await expect(page.locator('[data-role="film-maker"]')).toHaveCount(0);
    const hasFilmMaker = await page.evaluate(() => 'filmMaker' in (window as any).__viewer);
    expect(hasFilmMaker).toBe(false);
  });

  test('spinboxes update the selected keyframe velocities', async ({ page }) => {
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);
    await page.locator('#app canvas').click({ position: { x: 400, y: 300 } });
    await page.keyboard.press('Space');

    const linInput = page.locator('text=Linear Velocity (m/s):').locator('xpath=following-sibling::input[1]');
    await linInput.fill('42');
    await linInput.press('Enter');
    await linInput.blur();

    const angInput = page.locator('text=Angular Velocity (deg/s):').locator('xpath=following-sibling::input[1]');
    await angInput.fill('180');
    await angInput.press('Enter');
    await angInput.blur();

    const stopInput = page.locator('text=Stop Time (s):').locator('xpath=following-sibling::input[1]');
    await stopInput.fill('1.5');
    await stopInput.press('Enter');
    await stopInput.blur();

    const kf = await page.evaluate(() => {
      const v = (window as any).__viewer;
      const f = v.filmMaker.keyFrames[0];
      return { lin: f.linVel, angDeg: (f.angVel * 180) / Math.PI, stop: f.stopTime };
    });
    expect(kf.lin).toBeCloseTo(42, 5);
    expect(kf.angDeg).toBeCloseTo(180, 3);
    expect(kf.stop).toBeCloseTo(1.5, 5);
  });

  test('play with 2 key frames advances playback index and ends cleanly', async ({ page }) => {
    const { pageErrors } = attachErrorSinks(page);
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);

    // Add 2 key frames with different poses by nudging the camera in between.
    await page.evaluate(() => {
      const v = (window as any).__viewer;
      v.addKeyFrameFromCamera();
      // Move camera center to create a distinct second pose.
      v.cameraCenter.set(5, 3, 2);
      v.updateCamera();
      v.addKeyFrameFromCamera();
      // High velocities so playback is short.
      v.filmMaker.setLinVel(0, 100);
      v.filmMaker.setAngVel(0, Math.PI * 4);
    });

    const ok = await page.evaluate(() => (window as any).__viewer.startPlayback());
    expect(ok).toBe(true);
    await expect.poll(
      async () => await page.evaluate(() => (window as any).__viewer.isPlayingFilm),
      { timeout: 5_000 },
    ).toBe(false);

    const frameCount = await page.evaluate(() => (window as any).__viewer.filmMaker.frames.length);
    expect(frameCount).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test('record toggle produces a recorded blob after playback', async ({ page }) => {
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);

    const recorderOK = await page.evaluate(() => {
      const c = document.querySelector('#app canvas') as any;
      return !!(c && typeof c.captureStream === 'function' && typeof MediaRecorder !== 'undefined');
    });
    test.skip(!recorderOK, 'captureStream/MediaRecorder unavailable in this browser');

    await page.evaluate(() => {
      const v = (window as any).__viewer;
      v.addKeyFrameFromCamera();
      v.cameraCenter.set(2, 0, 0);
      v.updateCamera();
      v.addKeyFrameFromCamera();
      v.filmMaker.setLinVel(0, 50);
      v.filmMaker.setAngVel(0, Math.PI * 4);
      v.isRecordingFilm = true;
    });

    await page.evaluate(() => (window as any).__viewer.startPlayback());
    await expect.poll(
      async () => await page.evaluate(() => (window as any).__viewer.isPlayingFilm),
      { timeout: 10_000 },
    ).toBe(false);

    // Wait up to 2s for the onstop handler to assemble the blob.
    await expect.poll(
      async () => await page.evaluate(() => {
        const b = (window as any).__viewer.lastRecordedBlob;
        return b ? b.size : 0;
      }),
      { timeout: 5_000 },
    ).toBeGreaterThan(0);
  });

  test('jumpToKeyFrame moves the camera center to the stored keyframe pose', async ({ page }) => {
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);

    await page.evaluate(() => {
      const v = (window as any).__viewer;
      v.cameraCenter.set(10, 20, 30);
      v.updateCamera();
      v.addKeyFrameFromCamera();
      v.cameraCenter.set(0, 0, 0);
      v.updateCamera();
    });

    await page.evaluate(() => (window as any).__viewer.jumpToKeyFrame(0));
    const c = await page.evaluate(() => {
      const { x, y, z } = (window as any).__viewer.cameraCenter;
      return { x, y, z };
    });
    expect(c.x).toBeCloseTo(10, 2);
    expect(c.y).toBeCloseTo(20, 2);
    expect(c.z).toBeCloseTo(30, 2);
  });

  test('integrates with a loaded point cloud without errors', async ({ page }) => {
    const { pageErrors } = attachErrorSinks(page);
    await page.goto('/?mode=film_maker');
    await page.waitForFunction(() => (window as any).__viewer);
    await dropFile(page, 'synth.ply', makeAsciiPLY(800));
    await waitForPointCount(page);

    await page.locator('#app canvas').click({ position: { x: 500, y: 300 } });
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await expect(page.locator('text=Frame 2')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
