/**
 * Browser-safety guard (extraction plan T5) — @ai3-inference/verify is
 * isomorphic: the browser proof drawer imports it directly, so no shipped
 * module may touch a node-only API. This test statically scans every
 * non-test source file for node builtins, CommonJS require, and node-global
 * usage. Test files themselves are exempt (they run under node:test).
 *
 * The scan runs on src/ (the authored TS), resolved relative to this
 * compiled file in dist/ — the two trees are siblings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const shipped = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

const NODE_BUILTINS = [
  'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'stream',
  'buffer', 'child_process', 'worker_threads', 'url', 'util', 'zlib', 'events',
];

test('verify package ships at least the attestation + allowlist modules', () => {
  assert.ok(shipped.includes('autoinf-attestation.ts'));
  assert.ok(shipped.includes('image-tier-allowlist.ts'));
});

for (const file of shipped) {
  test(`browser-safe: ${file}`, () => {
    const text = readFileSync(join(srcDir, file), 'utf8');
    // no node: protocol imports
    assert.doesNotMatch(text, /from\s+['"]node:/, `${file} imports a node: builtin`);
    assert.doesNotMatch(text, /import\s+['"]node:/, `${file} imports a node: builtin`);
    // no bare builtin imports
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(importRe)) {
      const spec = m[1]!;
      assert.ok(
        !NODE_BUILTINS.includes(spec),
        `${file} imports node builtin '${spec}'`,
      );
    }
    // no CommonJS require, no node globals
    assert.doesNotMatch(text, /\brequire\s*\(/, `${file} uses require()`);
    assert.doesNotMatch(text, /\bprocess\.\w/, `${file} touches process.*`);
    assert.doesNotMatch(text, /\bBuffer\./, `${file} uses Buffer`);
    assert.doesNotMatch(text, /\b__dirname\b|\b__filename\b/, `${file} uses CJS path globals`);
  });
}
