import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { zhHans } from './zh-Hans.ts';

const root = new URL('.', import.meta.url).pathname;
const literal = /(?<![\w.])t\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function messages(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sources(root)) {
    for (const match of readFileSync(path, 'utf8').matchAll(literal)) {
      found.set(JSON.parse(`"${match[2].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`), path.slice(root.length));
    }
  }
  return found;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('every message has a Simplified Chinese translation with the same placeholders', () => {
  const found = messages();
  assert.ok(found.size > 100, `only ${found.size} messages found`);
  const missing = [...found].filter(([message]) => !zhHans[message]).map(([message, file]) => `${file}: ${message}`);
  assert.deepEqual(missing, []);
  for (const message of found.keys()) {
    assert.deepEqual(placeholders(zhHans[message]), placeholders(message), message);
  }
});

test('no translation is left over from removed text', () => {
  const found = messages();
  assert.deepEqual(Object.keys(zhHans).filter(message => !found.has(message)), []);
});
