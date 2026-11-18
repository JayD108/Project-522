import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served under /app/ by the Crostini server (http://localhost:8080/app/), so base is relative.
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Videos live in OPFS, never in the SW cache: only the small app shell is precached.
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'], navigateFallback: 'index.html' },
      manifest: {
        name: 'Jharokha',
        short_name: 'Jharokha',
        description: 'Live window wallpaper and room host',
        display: 'standalone',
        display_override: ['fullscreen', 'standalone'],
        background_color: '#000000',
        theme_color: '#0d0c0b',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 5173, strictPort: true },
});
