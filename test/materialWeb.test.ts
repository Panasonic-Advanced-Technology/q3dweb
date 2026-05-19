import { describe, expect, it } from 'vitest';
import { installMaterialWebTheme } from '../src/materialWeb';

describe('Material Web theme installation', () => {
  it('registers Material Web controls and marks the document as themed', () => {
    installMaterialWebTheme();

    expect(customElements.get('md-menu')).toBeDefined();
    expect(customElements.get('md-menu-item')).toBeDefined();
    expect(customElements.get('md-ripple')).toBeDefined();
    expect(document.documentElement.classList.contains('q3d-material-web-theme')).toBe(true);

    const adoptedCount = document.adoptedStyleSheets?.length ?? 0;
    const fallbackStyle = document.head.querySelector('[data-role="material-web-typescale"]');
    expect(adoptedCount > 0 || fallbackStyle).toBeTruthy();
  });
});