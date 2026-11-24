import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const PWA_DIR = fileURLToPath(new URL('.', import.meta.url));
const ICONS = [
  { file: 'icon-192.png', sizes: '192x192', purpose: 'any' },
  { file: 'icon-512.png', sizes: '512x512', purpose: 'any' },
  { file: 'icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
  { file: 'apple-touch-icon.png', sizes: '180x180', purpose: undefined },
] as const;
const THEME_COLOR = '#202124';
const BACKGROUND_COLOR = '#000000';

const manifest = {
  name: 'q3dviewer',
  short_name: 'q3dviewer',
  description: 'Web point cloud viewer (LAS/LAZ/E57/PLY/PCD)',
  id: './',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  icons: ICONS.filter((icon) => icon.purpose).map((icon) => ({
    src: `icons/${icon.file}`,
    sizes: icon.sizes,
    type: 'image/png',
    purpose: icon.purpose,
  })),
};

const REGISTER_SCRIPT = `if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed', error));
  });
}`;

/** Emits manifest, icons and a precaching service worker. Enabled only for the GitHub Pages build. */
export function pwaPlugin(): Plugin {
  return {
    name: 'q3dweb-pwa',
    apply: (_config, env) => env.command === 'build' && env.mode === 'github-pages',
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'manifest', href: './manifest.webmanifest' }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'theme-color', content: THEME_COLOR }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: './icons/apple-touch-icon.png' }, injectTo: 'head' },
        { tag: 'script', children: REGISTER_SCRIPT, injectTo: 'body' },
      ];
    },
    generateBundle(_options, bundle) {
      for (const icon of ICONS) {
        this.emitFile({
          type: 'asset',
          fileName: `icons/${icon.file}`,
          source: readFileSync(`${PWA_DIR}icons/${icon.file}`),
        });
      }
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(manifest, null, 2),
      });

      // index.html is served network-first, so it is left out of the build hash.
      const hash = createHash('sha256');
      const files = ['index.html', 'manifest.webmanifest', ...ICONS.map((icon) => `icons/${icon.file}`)];
      for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        if (fileName.endsWith('.map') || fileName === 'index.html') continue;
        files.push(fileName);
        hash.update(fileName);
        hash.update(output.type === 'chunk' ? output.code : output.source);
      }

      const sw = readFileSync(`${PWA_DIR}sw.js`, 'utf8')
        .replace('__PWA_BUILD_ID__', hash.digest('hex').slice(0, 16))
        .replace('__PWA_PRECACHE_FILES__', JSON.stringify([...new Set(files)]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}
