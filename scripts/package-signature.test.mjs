import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  makeDocument, privateKeyFromSeed, rawPublicKey, serialize, signPackage, SIGNATURE_FILE, verifyPackage,
} from './package-signature.mjs';

// The fixture's signature document was written by this script and verified
// by Lithe's own PluginPackageSignature (Swift CryptoKit). Ed25519 signing is
// deterministic, so producing the same bytes again proves the file walk, the
// payload, and the key handling still match what Lithe checks.
const fixture = new URL('./fixtures/signed-package/', import.meta.url).pathname;
const testKey = privateKeyFromSeed(Buffer.alloc(32, 1).toString('base64'));
const trusted = { 'lithe-test-key': rawPublicKey(testKey) };

const temporaries = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function copyOfFixture() {
  const root = await mkdtemp(join(tmpdir(), 'lithe-plugin-signature-'));
  temporaries.push(root);
  await cp(fixture, root, { recursive: true });
  return root;
}

test('signs the fixture exactly as Lithe verified it', async () => {
  const golden = await readFile(join(fixture, SIGNATURE_FILE), 'utf8');
  assert.equal(serialize(await makeDocument(fixture, testKey, trusted)), golden);
  await verifyPackage(fixture, trusted);
});

test('a changed, added, or removed file breaks the signature', async () => {
  for (const change of [
    root => writeFile(join(root, 'bin/tool'), 'changed'),
    root => writeFile(join(root, 'ui/extra.js'), ''),
    root => rm(join(root, '.hidden')),
  ]) {
    const root = await copyOfFixture();
    await change(root);
    await assert.rejects(verifyPackage(root, trusted), /changed after signing|file list/);
  }
});

test('refuses untrusted keys, a different plugin version, and links', async () => {
  await assert.rejects(verifyPackage(fixture), /does not trust/);
  const other = privateKeyFromSeed(Buffer.alloc(32, 2).toString('base64'));
  await assert.rejects(makeDocument(fixture, other, trusted), /does not belong/);

  const bumped = await copyOfFixture();
  await writeFile(join(bumped, 'plugin.json'), '{"id":"dev.lithe.fixture.signature","version":"1.2.4"}');
  await assert.rejects(verifyPackage(bumped, trusted), /invalid/);

  const linked = await copyOfFixture();
  await symlink('plugin.json', join(linked, 'link.json'));
  await assert.rejects(signPackage(linked, testKey, trusted), /symbolic link/);
});

test('re-signing replaces the document and verifies', async () => {
  const root = await copyOfFixture();
  await writeFile(join(root, 'bin/tool'), 'rebuilt');
  await signPackage(root, testKey, trusted);
  const document = await verifyPackage(root, trusted);
  assert.equal(document.keyID, 'lithe-test-key');
  assert.equal(Object.keys(document.files).length, 4);
});
