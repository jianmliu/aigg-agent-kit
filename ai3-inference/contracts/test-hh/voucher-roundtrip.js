/**
 * T8 round-trip gate — signatures produced by @ai3-inference/voucher (the TS
 * client half) must recover correctly ON-CHAIN in InferenceLedger:
 *
 *   • hashVoucher()  ===  ledger.voucherDigest()   (byte-identical digest)
 *   • signVoucher()  →   settle() succeeds, funds move, nonce burns
 *   • replay         →   NonceUsed
 *   • malleated high-s → BadSignature; normalizeSignature() repairs it
 *
 * The spec consumes the package's BUILT output (packages/voucher/dist), so
 * run `pnpm -r build` first — exactly what CI does before `pnpm -r test`.
 */
const { expect } = require('chai');
const { ethers } = require('hardhat');
const path = require('path');
const { pathToFileURL } = require('url');

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('Voucher round-trip (TS @ai3-inference/voucher ↔ InferenceLedger)', () => {
  let voucher; // the TS package (ESM, dynamically imported)
  let ledger, user, provider, domainParams, chainNow;

  before(async () => {
    const dist = path.join(__dirname, '..', '..', 'packages', 'voucher', 'dist', 'index.js');
    try {
      voucher = await import(pathToFileURL(dist).href);
    } catch (e) {
      throw new Error(`cannot import ${dist} — run \`pnpm -r build\` first (${e.message})`);
    }
  });

  beforeEach(async () => {
    [user, provider] = await ethers.getSigners();
    ledger = await (await ethers.getContractFactory('InferenceLedger')).deploy();
    domainParams = {
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await ledger.getAddress(),
    };
    await ledger.deposit({ value: ethers.parseEther('1') });
    await ledger.transferTo(provider.address, ethers.parseEther('1'));
    // the shared hardhat network time-travels in other specs — anchor expiry
    // to the CHAIN clock, not the wall clock.
    chainNow = BigInt((await ethers.provider.getBlock('latest')).timestamp);
  });

  /** adapt an ethers signer to the package's TypedDataSigner seam. */
  const asTypedDataSigner = (wallet) => ({
    signTypedData: ({ domain, types, message }) => wallet.signTypedData(domain, { Voucher: [...types.Voucher] }, message),
  });

  const makeVoucher = (nonce) => ({
    user: user.address,
    provider: provider.address,
    nonce,
    maxFee: ethers.parseEther('0.01'),
    expiry: chainNow + 3600n,
  });

  const asTuple = (v) => [v.user, v.provider, v.nonce, v.maxFee, v.expiry];

  it('hashVoucher matches the contract digest byte-for-byte', async () => {
    const v = makeVoucher(259n); // word 1, bit 3
    expect(voucher.hashVoucher(v, domainParams)).to.eq(await ledger.voucherDigest(asTuple(v)));
  });

  it('a TS-signed voucher settles: funds move, nonce burns, replay reverts', async () => {
    const v = makeVoucher(259n);
    const sig = await voucher.signVoucher(asTypedDataSigner(user), v, domainParams);
    const fee = ethers.parseEther('0.005');

    expect(await ledger.nonceUsed(user.address, provider.address, 259n)).to.eq(false);
    await expect(ledger.connect(provider).settle([asTuple(v)], [sig], [fee]))
      .to.emit(ledger, 'Settled').withArgs(user.address, provider.address, 259n, fee);
    expect(await ledger.balanceOf(user.address, provider.address)).to.eq(ethers.parseEther('1') - fee);
    expect(await ledger.accrued(provider.address)).to.eq(fee);
    expect(await ledger.nonceUsed(user.address, provider.address, 259n)).to.eq(true);
    // a neighbouring nonce in the same word stays free (bitmap math agrees)
    expect(await ledger.nonceUsed(user.address, provider.address, 258n)).to.eq(false);

    await expect(ledger.connect(provider).settle([asTuple(v)], [sig], [fee]))
      .to.be.revertedWithCustomError(ledger, 'NonceUsed');
  });

  it('high-s malleation is rejected on-chain; normalizeSignature repairs it', async () => {
    const v = makeVoucher(7n);
    const sig = await voucher.signVoucher(asTypedDataSigner(user), v, domainParams);
    // malleate: s' = N − s, v flipped — still a valid ECDSA pair for the digest
    const bytes = ethers.getBytes(sig);
    const s = BigInt(ethers.hexlify(bytes.slice(32, 64)));
    const high = new Uint8Array(bytes);
    high.set(ethers.getBytes(ethers.toBeHex(N - s, 32)), 32);
    high[64] = bytes[64] === 27 ? 28 : 27;
    const highHex = ethers.hexlify(high);
    const fee = ethers.parseEther('0.001');

    await expect(ledger.connect(provider).settle([asTuple(v)], [highHex], [fee]))
      .to.be.revertedWithCustomError(ledger, 'BadSignature');
    expect(voucher.isLowS(highHex)).to.eq(false);
    const repaired = voucher.normalizeSignature(highHex);
    expect(repaired).to.eq(sig);
    await expect(ledger.connect(provider).settle([asTuple(v)], [repaired], [fee]))
      .to.emit(ledger, 'Settled');
  });

  it('findFreeNonce driven by on-chain nonceUsed picks the next free slot', async () => {
    // burn nonces 0 and 1 with real settlements
    for (const nonce of [0n, 1n]) {
      const v = makeVoucher(nonce);
      const sig = await voucher.signVoucher(asTypedDataSigner(user), v, domainParams);
      await ledger.connect(provider).settle([asTuple(v)], [sig], [1n]);
    }
    // reconstruct each word's bits from the contract's nonceUsed view
    const readWord = async (word) => {
      let bits = 0n;
      for (let bit = 0n; bit < 4n; bit++) { // only low bits are in play here
        if (await ledger.nonceUsed(user.address, provider.address, word * 256n + bit)) bits |= 1n << bit;
      }
      return bits;
    };
    expect(await voucher.findFreeNonce(readWord)).to.eq(2n);
  });
});
