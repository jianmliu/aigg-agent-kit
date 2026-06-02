/**
 * Headless smoke for the donations indexer — fake JSON-RPC, no network.
 * Run: node donations-smoke.mjs
 */
import assert from 'node:assert/strict';
import { DonationsIndexer, addrTo32, word32ToAddr, decodeUint } from './donations.mjs';

const TBA = '0x22942f4c64b2c5ed385e7fe0c5b903948245bca1';
const DONOR_A = '0x00000000000000000000000000000000000000aa';
const DONOR_B = '0x00000000000000000000000000000000000000bb';
const GCC = '0x628626de13dd4b5b1cb80d468c261c15df00d717';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// fake fetch implementing eth_call (account/balanceOf) + eth_getLogs
function fakeFetch(_url, init) {
  const { method, params } = JSON.parse(init.body);
  let result;
  if (method === 'eth_call') {
    const to = params[0].to.toLowerCase();
    const data = params[0].data;
    if (data.startsWith('0x246a0021')) result = '0x' + addrTo32(TBA);          // account() → TBA
    else if (data.startsWith('0x70a08231')) result = '0x' + word('1500000000000000000'); // balanceOf → 1.5 GCC
    else result = '0x';
  } else if (method === 'eth_getLogs') {
    // two donations: A=1.0, B=0.5 (atoms 1e18, 5e17), to == TBA
    const toTopic = '0x' + addrTo32(TBA);
    result = [
      { topics: ['0xddf2', '0x' + addrTo32(DONOR_A), toTopic], data: '0x' + word('1000000000000000000') },
      { topics: ['0xddf2', '0x' + addrTo32(DONOR_B), toTopic], data: '0x' + word('500000000000000000') }
    ];
  }
  return Promise.resolve({ json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }) });
}

async function main() {
  // unit: encoders
  assert.equal(addrTo32(DONOR_A).length, 64, 'addr → 32-byte word');
  assert.equal(word32ToAddr('0x' + addrTo32(TBA)).toLowerCase(), TBA, 'word → addr round-trip');
  assert.equal(decodeUint('0x' + word('42')), 42n, 'decodeUint');

  const idx = new DonationsIndexer({
    nftAddress: '0x9999999999999999999999999999999999999999',
    gccToken: GCC, rpcUrl: 'http://fake', chainId: 84532,
    npcTokens: { 'npc:jiu-jianxian': 3 }, fetchImpl: fakeFetch
  });
  assert.ok(idx.configured(), 'indexer configured');

  const v = await idx.view('npc:jiu-jianxian');
  assert.equal(v.tba.toLowerCase(), TBA, 'TBA resolved via registry account()');
  assert.equal(v.tokenId, 3);
  assert.equal(v.balanceGcc, 1.5, 'balanceGcc decoded (1.5)');
  assert.equal(v.totalDonatedGcc, 1.5, 'total donated = 1.0 + 0.5');
  assert.equal(v.donors.length, 2, 'two donors');
  assert.equal(v.donors[0].gcc, 1.0, 'top donor sorted first (A=1.0)');
  assert.equal(v.donors[0].from.toLowerCase(), DONOR_A);
  assert.equal(v.transfers, 2);

  // unknown npc
  const u = await idx.view('npc:nobody');
  assert.equal(u.error, 'unknown_npc');

  // tba cached (second call doesn't recompute → still correct)
  assert.equal((await idx.tbaFor('npc:jiu-jianxian')).toLowerCase(), TBA);

  console.log('✓ encoders + account() TBA resolve + balanceOf + Transfer aggregation + sort + unknown');
  console.log('\nDONATIONS-INDEXER SMOKE PASSED ✅');
}

main().catch((err) => { console.error('DONATIONS SMOKE FAILED ❌', err); process.exit(1); });
