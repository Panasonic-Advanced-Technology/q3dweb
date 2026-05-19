import { makeLabel } from './viewer/settingsUI';

export type ViewerMode = 'cloud' | 'film_maker' | 'realtime';

const VIEWER_MODE_OPTIONS: Array<{ value: ViewerMode; label: string }> = [
    { value: 'cloud', label: 'cloud_viewer' },
    { value: 'film_maker', label: 'film_maker' },
    { value: 'realtime', label: 'realtime_viewer' },
];

export interface ViewerModeSelectorHost {
    settingsPanel: HTMLElement | null;
}

export interface ViewerModeHostApi {
    postMessage(message: { type: 'changeMode'; mode: ViewerMode }): void;
}

export function normalizeViewerMode(mode: string | null): ViewerMode {
    return mode === 'film_maker' || mode === 'realtime' ? mode : 'cloud';
}

export function getHostViewerMode(): ViewerMode | null {
    const hostMode = (globalThis as { __Q3DWEB_INITIAL_MODE?: unknown }).__Q3DWEB_INITIAL_MODE;
    return typeof hostMode === 'string' ? normalizeViewerMode(hostMode) : null;
}

export function navigateToViewerMode(mode: ViewerMode, host?: ViewerModeHostApi | null): void {
    if (host) {
        host.postMessage({ type: 'changeMode', mode });
        return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('mode', mode);
    window.location.assign(url.toString());
}

export function installViewerModeSelector(
    host: ViewerModeSelectorHost,
    currentMode: ViewerMode,
    navigate: (mode: ViewerMode) => void = navigateToViewerMode,
): HTMLSelectElement | null {
    if (!host.settingsPanel) return null;

    const panel = host.settingsPanel;
    const existing = panel.querySelector('[data-role="viewer-mode-select"]') as HTMLSelectElement | null;
    if (existing) return existing;

    const label = makeLabel('Viewer Mode:');
    label.setAttribute('data-role', 'viewer-mode-label');

    const select = document.createElement('select');
    select.setAttribute('data-role', 'viewer-mode-select');
    select.style.cssText = 'width:100%;margin-bottom:8px;background:#333;color:#eee;border:1px solid #666;padding:4px;border-radius:3px;';
    for (const option of VIEWER_MODE_OPTIONS) {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.label;
        select.appendChild(item);
    }
    select.value = currentMode;
    select.onchange = () => {
        const selectedMode = normalizeViewerMode(select.value);
        if (selectedMode === currentMode) return;
        navigate(selectedMode);
    };

    const anchor = panel.children[1] ?? null;
    panel.insertBefore(label, anchor);
    panel.insertBefore(select, anchor);
    return select;
}