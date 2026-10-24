// The Lithe publisher signature of a plugin package: lithe-plugin-signature.json
// at the package root, an Ed25519 signature over the SHA-256 of every file.
//
// This reproduces PluginPackageSignature in Lithe's
// macos/Sources/LithePluginPackageSigning byte for byte: the same file walk,
// the same canonical payload, and the same trusted key IDs. Lithe verifies
// the document when it installs and loads the plugin, so any drift here makes
// every release uninstallable; package-signature.test.mjs pins the format.
//
//   node scripts/package-signature.mjs sign <package>    (private key on stdin)
//   node scripts/package-signature.mjs verify <package>
//
// The private key is the base64 of the raw 32-byte Ed25519 seed. It exists only
// as a secret of the protected release environment and is read from stdin, so
// it never appears in a command line or a file.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstat, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNATURE_FILE = 'lithe-plugin-signature.json';
const SCHEMA_VERSION = 1;
const ALGORITHM = 'ed25519';

/** Every publisher key Lithe trusts, by key ID, as Lithe embeds them. */
export const OFFICIAL_KEYS = {
  'lithe-official-plugins-v2': 'yTjUaLpCNXXEQDuan5Ymw5rCtR0JeTNmh6hyTfOFjTs=',
};

// DER prefixes that wrap a raw Ed25519 key as PKCS#8 and SubjectPublicKeyInfo.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function privateKeyFromSeed(base64) {
  const seed = Buffer.from(base64.trim(), 'base64');
  if (seed.length !== 32) throw new Error('The private key must be the base64 of a 32-byte Ed25519 seed.');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function publicKeyFromRaw(base64) {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== 32) throw new Error('A trusted public key is not 32 bytes.');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function rawPublicKey(privateKey) {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('base64');
}

/** Unpadded base64url of the UTF-8 bytes, as Lithe writes IDs and paths into the payload. */
function token(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

const isValidKeyID = keyID => /^[a-z0-9._-]+$/.test(keyID);

/** SHA-256 of every regular file by package-relative path; links and unsafe paths are refused. */
export async function fileDigests(root) {
  const digests = {};
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const status = await lstat(path);
      if (status.isSymbolicLink()) throw new Error(`The package contains a symbolic link: ${relative}`);
      if (status.isDirectory()) {
        await walk(path, relative);
        continue;
      }
      if (relative === SIGNATURE_FILE) continue;
      if (!status.isFile() || /[\0\r\n]/.test(relative)) throw new Error(`The package contains an unsupported file: ${relative}`);
      digests[relative] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await walk(root, '');
  return digests;
}

function canonicalPayload({ keyID, pluginID, pluginVersion, files }) {
  const lines = [
    `schemaVersion=${SCHEMA_VERSION}`,
    `algorithm=${ALGORITHM}`,
    `keyID=${keyID}`,
    `pluginID=${token(pluginID)}`,
    `pluginVersion=${token(pluginVersion)}`,
    ...Object.keys(files).sort(compareUTF16).map(path => `file=${token(path)}=${files[path]}`),
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// Swift sorts String keys by Unicode scalar values; for the ASCII paths a
// package holds that equals code-unit order, which a plain comparison gives.
function compareUTF16(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readManifest(root) {
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  if (typeof manifest.id !== 'string' || !manifest.id || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('plugin.json has no id or version.');
  }
  return { pluginID: manifest.id, pluginVersion: manifest.version };
}

/** The key ID among `trustedKeys` that owns `privateKey`. */
export function keyIDFor(privateKey, trustedKeys) {
  const publicKey = rawPublicKey(privateKey);
  const keyID = Object.keys(trustedKeys).sort().find(id => trustedKeys[id] === publicKey);
  if (!keyID) throw new Error('The private key does not belong to a key Lithe trusts.');
  return keyID;
}

/** The signature document for the package at `root`, which is not written. */
export async function makeDocument(root, privateKey, trustedKeys = OFFICIAL_KEYS) {
  const keyID = keyIDFor(privateKey, trustedKeys);
  const { pluginID, pluginVersion } = await readManifest(root);
  const files = await fileDigests(root);
  const signature = sign(null, canonicalPayload({ keyID, pluginID, pluginVersion, files }), privateKey);
  return { schemaVersion: SCHEMA_VERSION, algorithm: ALGORITHM, keyID, pluginID, pluginVersion, files, signature: signature.toString('base64') };
}

/** Serialized with sorted keys, as Lithe's encoder writes it. */
export function serialize(document) {
  const sorted = value => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort(compareUTF16).map(key => [key, sorted(value[key])]))
    : value);
  return `${JSON.stringify(sorted(document), null, 2)}\n`;
}

export async function signPackage(root, privateKey, trustedKeys = OFFICIAL_KEYS) {
  const document = await makeDocument(root, privateKey, trustedKeys);
  const temporary = join(root, `.${SIGNATURE_FILE}.tmp`);
  await writeFile(temporary, serialize(document));
  await rename(temporary, join(root, SIGNATURE_FILE));
  return document;
}

/** Throws unless the package at `root` carries a valid signature by a trusted key. */
export async function verifyPackage(root, trustedKeys = OFFICIAL_KEYS) {
  const document = JSON.parse(await readFile(join(root, SIGNATURE_FILE), 'utf8'));
  const { pluginID, pluginVersion } = await readManifest(root);
  const publicKey = trustedKeys[document.keyID];
  if (!publicKey) throw new Error(`The package is signed by ${document.keyID}, which Lithe does not trust.`);
  const signature = Buffer.from(String(document.signature), 'base64');
  if (document.schemaVersion !== SCHEMA_VERSION || document.algorithm !== ALGORITHM || !isValidKeyID(document.keyID)
    || document.pluginID !== pluginID || document.pluginVersion !== pluginVersion || signature.length !== 64) {
    throw new Error('The signature document is invalid.');
  }
  const actual = await fileDigests(root);
  const signed = document.files ?? {};
  const paths = new Set([...Object.keys(actual), ...Object.keys(signed)]);
  for (const path of [...paths].sort(compareUTF16)) {
    if (!(path in actual) || !(path in signed)) throw new Error('The file list does not match the signature.');
    if (actual[path] !== signed[path]) throw new Error(`The file changed after signing: ${path}`);
  }
  if (!verify(null, canonicalPayload({ ...document, files: signed }), publicKeyFromRaw(publicKey), signature)) {
    throw new Error('The signature is invalid.');
  }
  return document;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, root] = process.argv.slice(2);
  try {
    if (command === 'sign' && root) {
      const document = await signPackage(root, privateKeyFromSeed(await readStdin()));
      console.error(`Signed ${document.pluginID} ${document.pluginVersion} with ${document.keyID}.`);
    } else if (command === 'verify' && root) {
      const document = await verifyPackage(root);
      console.error(`Verified ${document.pluginID} ${document.pluginVersion}, signed with ${document.keyID}.`);
    } else {
      console.error('usage: package-signature.mjs sign|verify <package>');
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
