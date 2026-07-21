import { defineConfig } from 'vite';

import { contractCatalogPlugin } from './vite/contractCatalogPlugin';

export default defineConfig({
  // GitHub Pages serves project sites below /<repository>/, while local
  // development should keep using the root URL.
  base: process.env.GITHUB_ACTIONS ? '/Factory/' : '/',
  plugins: [contractCatalogPlugin()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    watch: {
      ignored: ['**/public/data/contracts.json'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
