import { defineConfig } from 'vite';
export default defineConfig({
  appType: 'spa',
  build: { outDir: 'dist/client', sourcemap: false, target: 'es2022' },
  server: { host: '127.0.0.1', allowedHosts: ['localhost', '127.0.0.1'] },
});
