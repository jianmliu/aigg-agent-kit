import assert from 'node:assert/strict';
import { ZeroGStorageClient, FakeZeroGTransport } from '../index';

const BELIEF = "I won't fall for that scam again.";

async function main() {
  const t = new FakeZeroGTransport();
  const zg = new ZeroGStorageClient(t);

  const root = await zg.upload(BELIEF, 'belief');
  assert.ok(typeof root === 'string' && root.startsWith('0x'), 'upload → 0x rootHash');
  assert.equal(await zg.download(root), BELIEF, 'download round-trips the exact data');

  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(await t.contentId(enc('x')), await t.contentId(enc('x')), 'contentId deterministic');
  assert.notEqual(await t.contentId(enc('x')), await t.contentId(enc('y')), 'different bytes → different id');

  const v = await zg.verify(root);
  assert.equal(v.verified, true, 'verify intact → true');
  assert.equal(v.data, BELIEF, 'verify returns the recovered data');
  assert.equal((await zg.verify(root, BELIEF)).verified, true, 'verify matches expected → true');
  assert.equal((await zg.verify(root, 'something else')).verified, false, 'verify wrong expected → false');

  t._putRaw(root, enc('evil'));
  assert.equal((await zg.verify(root)).verified, false, 'verify tampered content → false');

  console.log('DATA-ONCHAIN SMOKE OK ✅');
}
main().catch((e) => { console.error('DATA-ONCHAIN SMOKE FAILED ❌', e); process.exit(1); });
