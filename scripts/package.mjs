// Builds the installable plugin package and its marketplace archive:
//
//   dist/<id>/                      the package Lithe installs
//   dist/<id>-<version>-macos.zip   the same folder, as `ditto --keepParent` zips it
//   dist/<id>-<version>-macos.zip.sha256
//
//   node scripts/package.mjs [--sign] [--host-only]
//
// The backend is one universal macOS executable (arm64 and x86_64), so one
// archive serves every Mac. `--host-only` builds just this Mac's architecture
// for quick local installs. `--sign` reads the publisher key from stdin, as
// package-signature.mjs does, signs the staged package, and verifies it
// against the keys Lithe trusts; only the protected release job passes it.
//
// Run `npm ci` in ui/ first; this script never installs anything.
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_KEYS, privateKeyFromSeed, signPackage, verifyPackage } from './package-signature.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const BINARY = 'lithe-database-backend';
const TARGETS = { arm64: 'aarch64-apple-darwin', x86_64: 'x86_64-apple-darwin' };

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function buildBackend(architectures) {
  const slices = [];
  for (const architecture of architectures) {
    const target = TARGETS[architecture];
    run('cargo', ['build', '--release', '--locked', '--manifest-path', 'backend/Cargo.toml', '-p', BINARY, '--target', target], { stdio: 'inherit' });
    slices.push(join(root, 'backend/target', target, 'release', BINARY));
  }
  const universal = join(root, 'backend/target', `${BINARY}-universal`);
  run('lipo', ['-create', ...slices, '-output', universal]);
  const built = run('lipo', ['-archs', universal]).trim().split(/\s+/).sort();
  if (built.join(' ') !== [...architectures].sort().join(' ')) {
    throw new Error(`The backend holds ${built.join(', ')}, expected ${architectures.join(', ')}.`);
  }
  // Apple silicon refuses to run unsigned code, and a cross-linked slice
  // carries no signature, so the universal file is signed ad hoc. Its
  // integrity in the package comes from the publisher signature.
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', universal]);
  run('codesign', ['--verify', '--strict', universal]);
  return universal;
}

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!['--sign', '--host-only'].includes(flag)) throw new Error(`Unknown option ${flag}`);
}
// Read the key before building, so a missing secret fails in seconds.
const privateKey = flags.has('--sign') ? privateKeyFromSeed(await readStdin()) : null;

const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const { id, version } = manifest;
const backendPath = manifest.backend.launch.path;
const webEntries = (manifest.ui?.toolWindows ?? []).map(window => window.web?.entry).filter(Boolean);
if (backendPath !== `bin/${BINARY}` || webEntries.some(entry => !entry.startsWith('ui/'))) {
  throw new Error('plugin.json must launch bin/lithe-database-backend and load pages from ui/.');
}

const architectures = flags.has('--host-only') ? [process.arch === 'arm64' ? 'arm64' : 'x86_64'] : Object.keys(TARGETS);
const backend = await buildBackend(architectures);
run('npm', ['run', 'build'], { cwd: join(root, 'ui'), stdio: 'inherit' });

const dist = join(root, 'dist');
const staged = join(dist, id);
await rm(dist, { recursive: true, force: true });
await mkdir(join(staged, 'bin'), { recursive: true });
await copyFile(join(root, 'plugin.json'), join(staged, 'plugin.json'));
await copyFile(join(root, 'LICENSE'), join(staged, 'LICENSE'));
await copyFile(backend, join(staged, backendPath));
await chmod(join(staged, backendPath), 0o755);
await cp(join(root, 'ui/dist'), join(staged, 'ui'), { recursive: true });
for (const entry of webEntries) await stat(join(staged, entry));

if (privateKey) {
  await signPackage(staged, privateKey, OFFICIAL_KEYS);
  await verifyPackage(staged, OFFICIAL_KEYS);
}

const archive = join(dist, `${id}-${version}-macos.zip`);
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', staged, archive]);
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${sha256}\n`);
console.log(`${archive}\n${sha256}${privateKey ? '' : '\n(unsigned: only installable from disk in a development build)'}`);
