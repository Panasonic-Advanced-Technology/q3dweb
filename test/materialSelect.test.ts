import { describe, expect, it } from 'vitest';
import { createMaterialMenuSelect } from '../src/viewer/materialSelect';

describe('createMaterialMenuSelect', () => {
  it('uses popover positioning and keeps the menu attached to its wrapper', () => {
    const select = createMaterialMenuSelect([
      { label: 'Viewer', value: 'viewer' },
      { label: 'Grid', value: 'grid' },
    ], 'viewer', () => {});
    document.body.appendChild(select.wrapper);

    expect(select.menu.parentElement).toBe(select.wrapper);
    expect((select.menu as HTMLElement & { positioning?: string }).positioning).toBe('popover');

    select.button.click();

    expect(select.button.getAttribute('aria-expanded')).toBe('true');
    expect(select.menu.parentElement).toBe(select.wrapper);

    select.menu.dispatchEvent(new Event('closed'));

    expect(select.button.getAttribute('aria-expanded')).toBe('false');

    select.wrapper.remove();
  });
});