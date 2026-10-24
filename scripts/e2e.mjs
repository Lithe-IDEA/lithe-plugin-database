// Runs e2e/database_plugin.rs against Lithe's Rust Core with the package
// scripts/package.mjs staged in dist/.
//
//   node scripts/e2e.mjs [--ref <commit|branch>] [--source <Lithe git URL or path>]
//
// Core lives in the Lithe repository, so the scenario is copied into
// rust/lithe-core/tests/ of a disposable Lithe checkout in .artifacts/lithe
// (only rust/ and shared/ are checked out) and run there with cargo. By
// default that checkout is the commit e2e/lithe-core.json pins.
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = join(root, '.artifacts', 'lithe');
const TEST = 'database_plugin';

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

/** Checks out `ref` from `source` into the disposable work directory, rust/ and shared/ only. */
async function checkoutCore(source, ref) {
  await mkdir(work, { recursive: true });
  await run('git', ['init', '-q', work]);
  await run('git', ['-C', work, 'sparse-checkout', 'set', '--cone', 'rust', 'shared']);
  // A named remote, because the partial clone fetches missing blobs from it later.
  await run('git', ['-C', work, 'config', 'remote.origin.url', source]);
  await run('git', ['-C', work, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref]);
  await run('git', ['-C', work, 'checkout', '-q', '--force', '--detach', 'FETCH_HEAD']);
  await run('git', ['-C', work, 'clean', '-q', '-f', '-d', '--', 'rust/lithe-core/tests']);
}

const { values } = parseArgs({ options: { ref: { type: 'string' }, source: { type: 'string' } } });
const pin = JSON.parse(await readFile(join(root, 'e2e/lithe-core.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const pkg = join(root, 'dist', manifest.id);
try {
  await access(join(pkg, manifest.backend.launch.path));
} catch {
  throw new Error(`Run node scripts/package.mjs first; ${pkg} has no backend.`);
}

// git runs inside the checkout, so a local source must be absolute.
const source = values.source && !/^[a-z]+:\/\//.test(values.source) ? resolve(values.source) : values.source;
await checkoutCore(source ?? `${pin.repository}.git`, values.ref ?? pin.revision);
await copyFile(join(root, 'e2e', `${TEST}.rs`), join(work, 'rust/lithe-core/tests', `${TEST}.rs`));
await run('cargo', ['test', '--locked', '--manifest-path', join(work, 'rust/Cargo.toml'), '-p', 'lithe-core',
  '--test', TEST, '--', '--nocapture'], {
  env: { ...process.env, LITHE_DATABASE_PLUGIN_PACKAGE: pkg },
});
