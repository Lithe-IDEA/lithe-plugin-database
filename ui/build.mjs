// Bundles the page into dist/: index.html, main.js, and style.css. The page
// loads only these package files; Lithe's content security policy refuses
// inline scripts, eval, and every network request.
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

const dist = new URL('./dist/', import.meta.url).pathname;
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  format: 'iife',
  target: 'safari17',
  minify: true,
  legalComments: 'linked',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outfile: `${dist}main.js`,
  logLevel: 'warning',
});
await copyFile('src/index.html', `${dist}index.html`);
await copyFile('src/style.css', `${dist}style.css`);
