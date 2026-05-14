import './style.css'
import { Viewer } from './viewer';
import { RealtimeViewer } from './realtime_viewer';

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

// Declare VS Code API
declare function acquireVsCodeApi(): any;

// Initialize Viewer
try {
    const params = new URLSearchParams(window.location.search);
    const useRealtime = params.get('mode') === 'realtime';
    const viewer = useRealtime ? new RealtimeViewer('app') : new Viewer('app');

    if (useRealtime && viewer instanceof RealtimeViewer) {
        const topicName = params.get('topic') ?? undefined;
        const maxPointsPerScanRaw = Number(params.get('maxScan'));
        const maxAccumulatedPointsRaw = Number(params.get('maxCloud'));
        const maxPointsPerScan = Number.isFinite(maxPointsPerScanRaw) && maxPointsPerScanRaw > 0
            ? Math.floor(maxPointsPerScanRaw)
            : undefined;
        const maxAccumulatedPoints = Number.isFinite(maxAccumulatedPointsRaw) && maxAccumulatedPointsRaw > 0
            ? Math.floor(maxAccumulatedPointsRaw)
            : undefined;
        viewer.setRealtimeOptions({
            topicName,
            maxPointsPerScan,
            maxAccumulatedPoints,
        });

        const rosWsUrl = params.get('ros');
        if (rosWsUrl) {
            viewer.connectRosbridge(rosWsUrl, {
                topicName,
                maxPointsPerScan,
                maxAccumulatedPoints,
                autoFitOnFirstChunk: true,
            });
            console.log(`Realtime mode enabled, connecting to rosbridge: ${rosWsUrl}`);
        } else {
            console.log('Realtime mode enabled. Provide ?ros=ws://host:9090 to auto-connect.');
        }
    }

    // Expose viewer on window for E2E tests and debugging.
    (window as any).__viewer = viewer;
    console.log("q3dviewer Initialized.");
    
    // Check if running in VS Code
    let vscode: any = null;
    try {
        vscode = acquireVsCodeApi();
        console.log("VS Code API detected");
    } catch(e) {
        console.log("Running in Standalone mode");
    }

    if (vscode) {
        // Share vscode API with the viewer (for host-side file save dialogs, etc.)
        (viewer as any).vscode = vscode;
        // VS Code Mode
        // Listen for messages from VS Code extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'loadData':
                case 'loadPCD':
                    viewer.loadData(message.value, message.filename);
                    break;
                case 'startStream':
                    viewer.startStream(message.totalSize, message.filename);
                    break;
                case 'chunk':
                    viewer.processChunk(message.data, message.offset);
                    break;
                case 'endStream':
                    viewer.finalizeStream();
                    break;
                case 'realtimePoints': {
                    const positions = toFloat32Array(message.positions);
                    const values = toFloat32Array(message.values);
                    const rgb = message.rgb !== undefined ? toUint8Array(message.rgb) : undefined;
                    const maxPoints = typeof message.maxPoints === 'number' ? message.maxPoints : undefined;
                    const autoFit = message.autoFitOnFirstChunk === true;
                    viewer.appendRealtimePoints(positions, values, rgb, maxPoints, autoFit);
                    break;
                }
                case 'realtimeReset':
                    viewer.resetRealtimeCloud();
                    break;
            }
        });

        // Signal readiness
        vscode.postMessage({ type: 'ready' });
    } else {
        // Standalone Mode
        console.log("Drag and drop a point cloud file (.pcd, .ply, .las, .laz, .e57) to view it.");
    }

} catch(e) {
    console.error("Initialization failed:", e);
    document.body.innerHTML = `<h1>Error: ${e}</h1>`;
}

