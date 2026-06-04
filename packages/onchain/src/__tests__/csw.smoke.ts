/**
 * Headless smoke for Model B (passkey / Coinbase Smart Wallet) TS adoption:
 * CswWalletClient + CswAgentWallet. A fake wallet-svc stands in for /csw/account
 * + /csw/erc1271; the passkey signer is a synthetic assertion (real WebAuthn runs
 * in the browser). Verifies the wire + that CswAgentWallet implements the
 * AgentWallet seam (address from CSW derivation, signature = ERC-1271 blob).
 * Run: pnpm --filter @onchainpal/onchain test:csw
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CswWalletClient, CswAgentWallet } from '../index';

const CSW = ('0x' + 'c5'.repeat(20)) as `0x${string}`;
const ERC1271 = ('0x' + 'cc'.repeat(64)) as `0x${string}`;
const TOK = 'tok';
// a passkey pubkey (P-256 x,y) — the CSW owner
const PK = { x: ('0x' + '11'.repeat(32)) as `0x${string}`, y: ('0x' + '22'.repeat(32)) as `0x${string}` };

async function main() {
  const calls: Array<{ path: string; auth: string; body: any }> = [];
  const svc = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const auth = String(req.headers.authorization || '');
      const body = b ? JSON.parse(b) : {};
      calls.push({ path: req.url || '', auth, body });
      if (auth !== `Bearer ${TOK}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/csw/account') return res.end(JSON.stringify({
        factory: '0x' + 'fa'.repeat(20), ownerBytes: ['0x' + '00'.repeat(64)],
        createAccountCalldata: '0x01', getAddressCalldata: '0x02', address: CSW
      }));
      if (req.url === '/csw/erc1271') return res.end(JSON.stringify({ erc1271: ERC1271, challenge: body.challenge ?? '0x' }));
      res.end('{}');
    });
  });
  await new Promise<void>((r) => svc.listen(0, () => r()));
  const port = (svc.address() as any).port;
  const client = new CswWalletClient({ baseUrl: `http://localhost:${port}`, authToken: TOK });

  // /csw/account derives the CSW counterfactual address from the passkey owner
  const acct = await client.account([PK], 0);
  assert.equal(acct.address, CSW, 'CSW address from /csw/account');
  assert.ok(acct.createAccountCalldata && acct.getAddressCalldata, 'factory calldata returned');
  assert.equal(calls[0].body.owners[0].x, PK.x, 'passkey owner forwarded');

  // synthetic passkey signer (real one wraps navigator.credentials.get in browser)
  let seenChallenge = '';
  const passkeySign = async (challenge: `0x${string}`) => {
    seenChallenge = challenge;
    return { authenticatorData: '0xaa', clientDataJSON: '0xbb', signature: '0xcc' } as const;
  };

  const wallet = await CswAgentWallet.create({ client, owners: [PK], passkeySign });
  assert.equal(wallet.address, CSW, 'CswAgentWallet.address = CSW counterfactual');
  assert.equal(await wallet.balanceGcc(), null);

  // signTypedData: derive challenge → passkey signs → wallet-svc packages ERC-1271
  const payload = {
    domain: { name: 'Guaranteed Capacity Credit', version: '1', chainId: 84532, verifyingContract: ('0x' + '62'.repeat(20)) as `0x${string}` },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
    ] },
    primaryType: 'TransferWithAuthorization',
    message: { from: CSW, to: ('0x' + '30'.repeat(20)) as `0x${string}`, value: 300000000000000n, validAfter: 0n, validBefore: 1900000000n, nonce: ('0x' + '11'.repeat(32)) as `0x${string}` }
  };
  const sig = await wallet.signTypedData(payload as any);
  assert.equal(sig, ERC1271, 'signTypedData returns the ERC-1271 blob from wallet-svc');
  assert.match(seenChallenge, /^0x[0-9a-f]{64}$/i, 'challenge derived as a 32-byte EIP-712 hash');
  const e1271Call = calls.find((c) => c.path === '/csw/erc1271')!;
  assert.equal(e1271Call.body.authenticatorData, '0xaa', 'assertion forwarded to /csw/erc1271');
  assert.equal(e1271Call.body.ownerIndex, 0);

  svc.close();
  console.log('✓ Model B: /csw/account → CSW address; passkey assertion → /csw/erc1271 → ERC-1271 sig; AgentWallet seam');
  console.log('\nCSW SMOKE PASSED ✅');
}

main().catch((err) => { console.error('CSW SMOKE FAILED ❌', err); process.exit(1); });
