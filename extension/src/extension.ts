import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as v8 from 'v8';

type ViewerMode = 'cloud' | 'film_maker' | 'realtime';

function normalizeViewerMode(mode: unknown): ViewerMode {
    return mode === 'film_maker' || mode === 'realtime' ? mode : 'cloud';
}

export function activate(context: vscode.ExtensionContext) {
    // Register the custom editor provider
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            PcdViewerProvider.viewType,
            new PcdViewerProvider(context),
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );
}

class PcdDocument implements vscode.CustomDocument {
    constructor(
        public readonly uri: vscode.Uri
    ) { }

    dispose(): void { }
}

class PcdViewerProvider implements vscode.CustomReadonlyEditorProvider<PcdDocument> {

    public static readonly viewType = 'q3dviewer.pcdViewer';

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    public async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<PcdDocument> {
        return new PcdDocument(uri);
    }

    /**
     * Called when our custom editor is opened.
     */
    public async resolveCustomEditor(
        document: PcdDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Setup initial content for the webview
        webviewPanel.webview.options = {
            enableScripts: true,
             localResourceRoots: [
                vscode.Uri.file(path.join(this.context.extensionPath, 'webview-dist'))
            ]
        };

        let webviewReady = false;
        let currentMode: ViewerMode = 'cloud';
        let webviewGeneration = 0;
        const tryUpdateWebview = () => {
            if (webviewReady && currentMode !== 'realtime') {
                const generation = webviewGeneration;
                void this.updateWebview(
                    webviewPanel,
                    document,
                    () => webviewReady && currentMode !== 'realtime' && generation === webviewGeneration
                );
            }
        };

        const reloadWebview = (mode: ViewerMode) => {
            currentMode = mode;
            webviewReady = false;
            webviewGeneration += 1;
            webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, currentMode);
        };

        // Receive messages before setting HTML to avoid missing an early "ready".
        const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async e => {
            switch (e.type) {
                case 'ready':
                    currentMode = normalizeViewerMode(e.mode ?? currentMode);
                    webviewReady = true;
                    tryUpdateWebview();
                    return;
                case 'changeMode': {
                    const nextMode = normalizeViewerMode(e.mode);
                    if (nextMode !== currentMode) reloadWebview(nextMode);
                    return;
                }
                case 'saveVideo': {
                    try {
                        const defaultName = typeof e.filename === 'string' && e.filename ? e.filename : 'q3dweb.webm';
                        const ext = defaultName.toLowerCase().endsWith('.mp4') ? 'mp4' : 'webm';
                        // Suggest next to the opened document if it is a workspace file.
                        const baseDir = document.uri.scheme === 'file'
                            ? path.dirname(document.uri.fsPath)
                            : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir());
                        const defaultUri = vscode.Uri.file(path.join(baseDir, defaultName));
                        const target = await vscode.window.showSaveDialog({
                            defaultUri,
                            filters: ext === 'mp4' ? { 'MP4 Video': ['mp4'] } : { 'WebM Video': ['webm'] },
                            title: 'Save recorded video',
                        });
                        if (!target) return;
                        const bytes: Uint8Array = e.data instanceof Uint8Array
                            ? e.data
                            : new Uint8Array(e.data ?? []);
                        await vscode.workspace.fs.writeFile(target, bytes);
                        vscode.window.showInformationMessage(`Saved recording to ${target.fsPath}`);
                    } catch (err) {
                        console.error('saveVideo failed:', err);
                        vscode.window.showErrorMessage(`Failed to save recording: ${err instanceof Error ? err.message : String(err)}`);
                    }
                    return;
                }
            }
        });

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, currentMode);

        // Listen for changes in the document (file change on disk)
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(_e => {
            // For binary files, we use a file watcher instead
        });
        
        // Use a file watcher to reload data if changed externally
        const watcher = vscode.workspace.createFileSystemWatcher(document.uri.fsPath);
        watcher.onDidChange(() => {
             tryUpdateWebview();
        });
        watcher.onDidCreate(() => {
            tryUpdateWebview();
        });

        // Make sure we get rid of the listener when our editor is closed.
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
            messageSubscription.dispose();
            watcher.dispose();
        });
    }

    private getHtmlForWebview(webview: vscode.Webview, mode: ViewerMode): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.file(
            path.join(this.context.extensionPath, 'webview-dist', 'assets', 'main.js')
        ));
        const styleUri = webview.asWebviewUri(vscode.Uri.file(
            path.join(this.context.extensionPath, 'webview-dist', 'assets', 'viewer.css')
        ));

        // Use a nonce to whitelist which scripts can be run
        const nonce = getNonce();
        const heapBudget = getNodeHeapBudget();

        return /* html */`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; connect-src 'self' data: blob: ${webview.cspSource} https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://cyberjapandata.gsi.go.jp ws: wss:; img-src ${webview.cspSource} 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://cyberjapandata.gsi.go.jp; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval' 'wasm-unsafe-eval';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" type="text/css" href="${styleUri}" />
                <title>q3dviewer</title>
                <style>
                    body { margin: 0; overflow: hidden; width: 100vw; height: 100vh; }
                    #app { width: 100%; height: 100%; }
                </style>
            </head>
            <body>
                <div id="app"></div>
                <script nonce="${nonce}">
                    globalThis.__Q3DWEB_INITIAL_MODE = ${JSON.stringify(mode)};
                    globalThis.__Q3DWEB_HOST_HEAP_LIMIT_BYTES = ${heapBudget.hostHeapLimitBytes};
                    globalThis.__Q3DWEB_HOST_HEAP_USED_BYTES = ${heapBudget.hostHeapUsedBytes};
                </script>
                <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    /**
     * Send data to webview
     */
    private async updateWebview(
        webviewPanel: vscode.WebviewPanel,
        document: PcdDocument,
        shouldContinue: () => boolean = () => true,
    ) {
        try {
             if (!shouldContinue()) return;
             if (document.uri.scheme === 'file') {
                 const filePath = document.uri.fsPath;
                 const stats = fs.statSync(filePath);
                 const totalSize = stats.size;
                 const chunkSize = 1 * 1024 * 1024; // 1MB chunks for reliable webview messaging
                 const buffer = Buffer.alloc(chunkSize);
                 const fd = fs.openSync(filePath, 'r');
                 const heapBudget = getNodeHeapBudget();
                 
                 const startDelivered = await webviewPanel.webview.postMessage({ type: 'startStream', totalSize, filename: path.basename(filePath), ...heapBudget });
                 if (!startDelivered || !shouldContinue()) {
                     console.warn('Webview is not ready to receive startStream message.');
                     fs.closeSync(fd);
                     return;
                 }

                 let offset = 0;
                 try {
                     while (offset < totalSize && shouldContinue()) {
                         const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, offset);
                         const dataToSend = new Uint8Array(buffer.subarray(0, bytesRead));
                         
                         const delivered = await webviewPanel.webview.postMessage({ 
                             type: 'chunk', 
                             data: dataToSend,
                             offset 
                         });
                         if (!delivered || !shouldContinue()) {
                             console.warn('Webview rejected a chunk message. Stopping stream.');
                             break;
                         }
                         
                         offset += bytesRead;
                         // Small yield to prevent event loop starvation
                         await new Promise(resolve => setTimeout(resolve, 1));
                     }
                     
                     if (shouldContinue()) await webviewPanel.webview.postMessage({ type: 'endStream' });
                     
                 } catch(err) {
                    console.error("Error reading file chunks", err);
                 } finally {
                     fs.closeSync(fd);
                 }

             } else {
                 // Fallback for non-file schemes (e.g. remote)
                 const fileData = await vscode.workspace.fs.readFile(document.uri);
                 const heapBudget = getNodeHeapBudget();
                 if (!shouldContinue()) return;
                 webviewPanel.webview.postMessage({
                     type: 'loadData',
                     value: fileData,
                     filename: path.basename(document.uri.fsPath),
                     ...heapBudget,
                 });
             }
        } catch (e) {
            console.error('Failed to read file', e);
        }
    }
}

function getNodeHeapBudget(): { hostHeapLimitBytes: number; hostHeapUsedBytes: number } {
    const heapStats = v8.getHeapStatistics();
    return {
        hostHeapLimitBytes: heapStats.heap_size_limit,
        hostHeapUsedBytes: process.memoryUsage().heapUsed,
    };
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
