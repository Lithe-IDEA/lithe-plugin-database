// Verifies the reviewed official SDK source snapshot before builds/packages.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../vendor/lithe-plugin-sdk/', import.meta.url));
const provenance = JSON.parse(await readFile(join(directory, 'source-provenance.json'), 'utf8'));
if (provenance.repository !== 'https://github.com/Lithe-IDEA/lithe-plugin-docs'
    || !/^[a-f0-9]{40}$/.test(provenance.baseRevision)
    || typeof provenance.localChanges !== 'string' || !provenance.localChanges.trim()) {
  throw new Error('Invalid SDK source provenance.');
}
const actual = [];
async function inspect(relative = '') {
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`SDK snapshot contains a symbolic link: ${name}`);
    if (entry.isDirectory()) await inspect(name);
    else if (entry.isFile() && name !== 'source-provenance.json') actual.push(name);
    else if (!entry.isFile()) throw new Error(`SDK snapshot contains a special file: ${name}`);
  }
}
await inspect();
const expected = Object.keys(provenance.files).sort();
if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error('SDK snapshot file list differs from provenance.');
for (const name of expected) {
  const digest = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
  if (digest !== provenance.files[name]) throw new Error(`SDK source hash differs: ${name}`);
}
console.log(`Verified ${expected.length} SDK source files against ${provenance.baseRevision} plus declared local changes.`);
