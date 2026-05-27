import { makeLabel } from './viewer/settingsUI';
import { createMaterialMenuSelect } from './viewer/materialSelect';

export type ViewerMode = 'cloud' | 'film_maker' | 'realtime' | 'realtime_gnss';

const VIEWER_MODE_OPTIONS: Array<{ value: ViewerMode; label: string }> = [
    { value: 'cloud', label: 'cloud_viewer' },
    { value: 'film_maker', label: 'film_maker' },
    { value: 'realtime', label: 'realtime_viewer' },
    { value: 'realtime_gnss', label: 'realtime_gnss_viewer' },
];

export interface ViewerModeSelectorHost {
    settingsPanel: HTMLElement | null;
}

export interface ViewerModeHostApi {
    postMessage(message: { type: 'changeMode'; mode: ViewerMode }): void;
}

export function normalizeViewerMode(mode: string | null): ViewerMode {
    return mode === 'film_maker' || mode === 'realtime' || mode === 'realtime_gnss' ? mode : 'cloud';
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

    let activeMode = currentMode;

    const modeSelect = createMaterialMenuSelect(VIEWER_MODE_OPTIONS, currentMode, (value) => {
        const selectedMode = normalizeViewerMode(value);
        if (selectedMode === activeMode) return;
        navigate(selectedMode);
        activeMode = selectedMode;
    }, {
        dataRole: 'viewer-mode-select',
        menuDataRole: 'viewer-mode-select-menu',
        buttonDataRole: 'viewer-mode-menu-button',
        ariaLabel: 'Viewer mode',
        className: 'q3d-viewer-mode-select',
    });

    const anchor = panel.children[1] ?? null;
    panel.insertBefore(label, anchor);
    panel.insertBefore(modeSelect.wrapper, anchor);
    return modeSelect.select;
}