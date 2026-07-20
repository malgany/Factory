import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves project sites below /<repository>/, while local
  // development should keep using the root URL.
  base: process.env.GITHUB_ACTIONS ? '/Factory/' : '/',
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
