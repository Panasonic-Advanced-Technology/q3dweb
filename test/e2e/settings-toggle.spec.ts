import { test, expect, Page } from '@playwright/test';
import { dropFile, getSettingsItemSelect, makeAsciiPLY, waitForPointCount } from './helpers';

/**
 * M キーで設定パネルを閉じて再度開いたとき、閉じる前と同じタブ・内容が
 * 保持されることを保証する e2e テスト。過去に以下 3 つのバグで回帰したため、
 * 退行防止としてそれぞれのシナリオをカバーする。
 *
 *  1. addItem/removeItem 由来の refreshSettingsItemList がパネル非表示中に
 *     onSettingsItemSelected を呼び content を再構築していた (0.0.17/18)
 *  2. addItem('cloud') の自動遷移が「表示中のみ」に限定されていて、
 *     非表示中に再ロードすると main_win に固定された (0.0.19)
 *  3. <select> のタイプアヘッドで 'm' が "main win(Viewer)" を選択する (0.0.20/21)
 */

async function panelMinimized(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
        const v = (window as any).__viewer;
        return v?.settingsPanel?.getAttribute('data-minimized') === 'true';
    });
}

async function currentTab(page: Page): Promise<string> {
    return await page.evaluate(() => (window as any).__viewer?.settingsItemSelect?.value);
}

test.describe('M toggle preserves settings panel state', () => {
    test('reopening with M keeps the Film Maker tab active', async ({ page }) => {
        await page.goto('/?mode=film_maker');
        await page.waitForFunction(() => (window as any).__viewer);

        await expect(page.locator('[data-role="film-maker"]')).toBeVisible();

        // フォーカスを body に移す
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        await page.keyboard.press('m');
        expect(await panelMinimized(page)).toBe(true);

        await page.keyboard.press('m');
        expect(await panelMinimized(page)).toBe(false);
        await expect(page.locator('[data-role="film-maker"]')).toBeVisible();
    });

    test('reopening with M keeps the per-item cloud tab active', async ({ page }) => {
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__viewer);

        await dropFile(page, 'synth.ply', makeAsciiPLY(500));
        await waitForPointCount(page);

        expect(await currentTab(page)).toBe('cloud');

        await page.locator('body').click({ position: { x: 1, y: 1 } });
        await page.keyboard.press('m');
        expect(await panelMinimized(page)).toBe(true);

        await page.keyboard.press('m');
        expect(await panelMinimized(page)).toBe(false);
        expect(await currentTab(page)).toBe('cloud');
        await expect(page.locator('text=Points:')).toBeVisible();
    });

    test('pressing M while the select has focus does not jump to main_win (typeahead)', async ({ page }) => {
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__viewer);

        await dropFile(page, 'synth.ply', makeAsciiPLY(500));
        await waitForPointCount(page);

        const select = getSettingsItemSelect(page);
        await select.selectOption('cloud');
        await select.focus();
        await expect(select).toBeFocused();

        await page.keyboard.press('m');
        expect(await panelMinimized(page)).toBe(true);

        await page.keyboard.press('m');
        expect(await panelMinimized(page)).toBe(false);
        expect(await currentTab(page)).toBe('cloud');
    });

    test('M is ignored while typing in a text input', async ({ page }) => {
        await page.goto('/');
        await page.waitForFunction(() => (window as any).__viewer);

        const colorInput = page
            .locator('text=Set background color:')
            .locator('..')
            .locator('input[type="text"]');
        await colorInput.focus();
        await colorInput.fill('');
        await page.keyboard.type('#abcdef');

        await page.keyboard.press('m');
        // パネルは開いたまま (ショートカット無効)
        expect(await panelMinimized(page)).toBe(false);
        // 入力には 'm' が追記されている
        expect(await colorInput.inputValue()).toBe('#abcdefm');
    });
});
