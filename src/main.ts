import './style.css'
import { installMaterialWebTheme } from './materialWeb';
import { FilmMakerViewer } from './film_maker_viewer';
import { RealtimeViewer } from './realtime_viewer';
import { RealtimeGnssViewer } from './realtime_gnss_viewer';
import { CloudViewer } from './cloud_viewer';
import { getHostViewerMode, installViewerModeSelector, navigateToViewerMode, normalizeViewerMode, type ViewerMode } from './viewerMode';
import { configureSamplingHeapBudget } from './parsers/sampling';
import { parseRealtimeUrlOptions } from './realtimeUrlOptions';
import { parseCloudUrlOptions } from './cloudUrlOptions';

function isRealtimeMode(mode: ViewerMode): boolean {
    return mode === 'realtime' || mode === 'realtime_gnss';
}

function isCloudCompatibleMode(mode: ViewerMode): mode is Extract<ViewerMode, 'cloud' | 'film_maker'> {
    return mode === 'cloud' || mode === 'film_maker';
}

function toFloat32Array(data: unknown): Float32Array {
    if (data instanceof Float32Array) return data;
    if (data instanceof ArrayBuffer) return new Float32Array(data);
    if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / Float32Array.BYTES_PER_ELEMENT));
    }
    if (Array.isArray(data)) return new Float32Array(data);
    return new Float32Array(0);
}

function toUint8Array(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof Uint8ClampedArray) return new Uint8Array(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (Array.isArray(data)) return new Uint8Array(data);
    return new Uint8Array(0);
}

function applyHostHeapBudget(message: any): void {
    configureSamplingHeapBudget(message.hostHeapLimitBytes, message.hostHeapUsedBytes);
}

function replaceStandaloneViewerMode(mode: Extract<ViewerMode, 'cloud' | 'film_maker'>): void {
    const url = new URL(window.location.href);
    url.searchParams.set('mode', mode);
    window.history.replaceState(window.history.state, '', url.toString());
}

// Declare VS Code API
declare function acquireVsCodeApi(): any;

// Initialize Viewer
try {
    installMaterialWebTheme();

    let vscode: any = null;
    try {
        vscode = acquireVsCodeApi();
        console.log("VS Code API detected");
    } catch(e) {
        console.log("Running in Standalone mode");
    }

    const params = new URLSearchParams(window.location.search);
    const mode = getHostViewerMode() ?? normalizeViewerMode(params.get('mode'));
    const realtimeOptions = isRealtimeMode(mode) ? parseRealtimeUrlOptions(params) : undefined;
    const cloudOptions = isRealtimeMode(mode) ? undefined : parseCloudUrlOptions(params);
    const initialCloudMode: Extract<ViewerMode, 'cloud' | 'film_maker'> = mode === 'film_maker' ? 'film_maker' : 'cloud';
    const viewer: CloudViewer | RealtimeViewer | RealtimeGnssViewer =
        mode === 'realtime' ? new RealtimeViewer('app', realtimeOptions) :
        mode === 'realtime_gnss' ? new RealtimeGnssViewer('app', realtimeOptions) :
                                   new FilmMakerViewer('app', cloudOptions, initialCloudMode);
    installViewerModeSelector(viewer, mode, nextMode => {
        if (viewer instanceof FilmMakerViewer && isCloudCompatibleMode(nextMode)) {
            viewer.setViewerMode(nextMode);
            if (vscode) {
                vscode.postMessage({ type: 'modeChanged', mode: nextMode });
            } else {
                replaceStandaloneViewerMode(nextMode);
            }
            return;
        }
        navigateToViewerMode(nextMode, vscode);
    });

    if (mode === 'realtime' && viewer instanceof RealtimeViewer) {
        if (realtimeOptions?.rosbridgeUrl) {
            viewer.connectRosbridge(realtimeOptions.rosbridgeUrl, realtimeOptions);
            console.log(`Realtime mode enabled, connecting to rosbridge: ${realtimeOptions.rosbridgeUrl}`);
        } else {
            console.log('Realtime mode enabled. Configure settings in the panel, or provide ?ros=ws://host:9090&cloudTopic=/points&odomTopic=/odom to auto-connect.');
        }
    } else if (mode === 'realtime_gnss' && viewer instanceof RealtimeGnssViewer) {
        if (realtimeOptions?.rosbridgeUrl) {
            viewer.connectRosbridge(realtimeOptions.rosbridgeUrl, realtimeOptions);
            console.log(`Realtime GNSS mode enabled, connecting to rosbridge: ${realtimeOptions.rosbridgeUrl}`);
        } else {
            console.log('Realtime GNSS mode enabled. Configure settings in the panel, or provide ?ros=ws://host:9090&gnss1Topic=/gnss1&gnss2Topic=/gnss2 to auto-connect.');
        }
    } else if (viewer instanceof CloudViewer && cloudOptions?.pointCloudUrl) {
        void viewer.loadUrl(cloudOptions.pointCloudUrl, cloudOptions.filename);
        console.log(`${mode} mode enabled, loading point cloud URL: ${cloudOptions.pointCloudUrl}`);
    }

    // Expose viewer on window for E2E tests and debugging.
    (window as any).__viewer = viewer;
    console.log("q3dviewer Initialized.");
    
    if (vscode) {
        // Share vscode API with the viewer (for host-side file save dialogs, etc.)
        (viewer as any).vscode = vscode;
        // VS Code Mode
        // Listen for messages from VS Code extension
        const cv = viewer instanceof CloudViewer ? viewer : null;
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'loadData':
                case 'loadPCD':
                    applyHostHeapBudget(message);
                    void cv?.loadData(message.value, message.filename);
                    break;
                case 'startStream':
                    applyHostHeapBudget(message);
                    cv?.startStream(message.totalSize, message.filename);
                    break;
                case 'chunk':
                    cv?.processChunk(message.data, message.offset);
                    break;
                case 'endStream':
                    void cv?.finalizeStream();
                    break;
                case 'realtimePoints': {
                    const positions = toFloat32Array(message.positions);
                    const values = toFloat32Array(message.values);
                    const rgb = message.rgb !== undefined ? toUint8Array(message.rgb) : undefined;
                    const maxPoints = typeof message.maxPoints === 'number' ? message.maxPoints : undefined;
                    const autoFit = message.autoFitOnFirstChunk === true;
                    cv?.appendRealtimePoints(positions, values, rgb, maxPoints, autoFit);
                    break;
                }
                case 'realtimeReset':
                    cv?.resetRealtimeCloud();
                    break;
            }
        });

        // Signal readiness
        vscode.postMessage({ type: 'ready', mode: viewer instanceof FilmMakerViewer ? viewer.currentViewerMode : mode });
    } else {
        // Standalone Mode
        console.log("Drag and drop a point cloud file (.pcd, .ply, .las, .laz, .e57) to view it.");
    }

} catch(e) {
    console.error("Initialization failed:", e);
    document.body.innerHTML = `<h1>Error: ${e}</h1>`;
}

