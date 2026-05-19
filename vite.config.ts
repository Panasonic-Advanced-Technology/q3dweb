import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    base: './',
    esbuild: {
      keepNames: true,
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: 'index.html',
        },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      exclude: ['extension/**', 'q3d-extension/**', 'node_modules/**'],
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      testTimeout: 120000,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'json-summary'],
        reportOnFailure: true,
        include: ['src/**/*.ts'],
        exclude: [
          'src/**/*.d.ts',
          'src/main.ts',
        ],
      },
    },
  };
});
