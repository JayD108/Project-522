#!/usr/bin/env node
// One command to run Jharokha:  npm start
//   1. checks Node, 2. installs app deps if missing, 3. builds the app, 4. starts the server.
//   npm start -- --no-build   skip the build (use the existing app/dist)
//   npm run dev               server + Vite hot-reload dev server on :5173
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const args = process.argv.slice(2);
const DEV = args.includes('--dev');
const shell = process.platform === 'win32';
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) die(`Node ${process.version} is too old: Jharokha needs Node 22.13+ (see SETUP.md).`);

if (!fs.existsSync(path.join(APP, 'node_modules'))) {
  console.log('→ Installing app dependencies (first run)…');
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: APP, stdio: 'inherit', shell });
  if (r.status !== 0) die('npm ci failed: check your internet connection, then run `npm run setup`.');
}

if (!DEV && !args.includes('--no-build')) {
  console.log('→ Building the app…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: APP, stdio: 'inherit', shell });
  if (r.status !== 0) die('Build failed (see errors above). `npm test` writes a full report to test-run-*.log.');
}

if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const port = process.env.PORT || 8080;
console.log('→ Starting the server…\n');
await import(pathToFileURL(path.join(ROOT, 'server', 'probe-server.mjs')).href);

setTimeout(() => {
  console.log(`\n  ▶ Open Jharokha:  http://localhost:${port}/app/${DEV ? '   (built copy)' : ''}`);
  if (DEV) console.log('  ▶ Hot-reload dev: http://localhost:5173/  (uses this server for /samples, /api)');
  console.log('    First run: click "Load sample wallpapers", then Start. Two screens → dual-screen; one → single.');
  console.log('    Stop with Ctrl+C.\n');
}, 300);

if (DEV) {
  const vite = spawn('npm', ['run', 'dev'], { cwd: APP, stdio: 'inherit', shell });
  const stop = () => { vite.kill(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
