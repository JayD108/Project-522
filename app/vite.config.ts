import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served under /app/ by the Crostini server (http://localhost:8080/app/), so base is relative.
export default defineConfig({
  base: './',
  // Two pages: the dashboard (index.html, both screens) and the phone room page (room.html).
  build: { rollupOptions: { input: { main: 'index.html', room: 'room.html' } } },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Videos live in OPFS, never in the SW cache: only the small app shell is precached.
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'], navigateFallback: 'index.html' },
      manifest: {
        name: 'Jharokha',
        short_name: 'Jharokha',
        description: 'Live window wallpaper and room host',
        display: 'standalone',
        display_override: ['fullscreen', 'standalone'],
        background_color: '#000000',
        theme_color: '#0d0c0b',
        start_url: './',
        // Android: "Share → Jharokha" from Instagram/YouTube drops the link into the phone room page.
        share_target: { action: './room.html', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // `npm run dev` (hot reload) proxies server routes to the Jharokha server on :8080 (npm start).
  server: {
    port: 5173, strictPort: true,
    proxy: {
      ...Object.fromEntries(['/api', '/samples', '/clips', '/health', '/ping', '/loop.js'].map((p) => [p, 'http://localhost:8080'])),
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
