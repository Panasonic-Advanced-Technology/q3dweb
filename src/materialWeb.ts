import '@material/web/menu/menu.js';
import '@material/web/menu/menu-item.js';
import '@material/web/ripple/ripple.js';
import { styles as typescaleStyles } from '@material/web/typography/md-typescale-styles.js';

let materialWebThemeInstalled = false;

export function installMaterialWebTheme(): void {
    if (materialWebThemeInstalled || typeof document === 'undefined') return;
    materialWebThemeInstalled = true;

    document.documentElement.classList.add('q3d-material-web-theme');
    const cssResult = typescaleStyles as unknown as { styleSheet?: CSSStyleSheet; cssText?: string };
    const styleSheet = cssResult.styleSheet;
    if (styleSheet && 'adoptedStyleSheets' in document) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];
        return;
    }

    if (cssResult.cssText) {
        const style = document.createElement('style');
        style.setAttribute('data-role', 'material-web-typescale');
        style.textContent = cssResult.cssText;
        document.head.appendChild(style);
    }
}