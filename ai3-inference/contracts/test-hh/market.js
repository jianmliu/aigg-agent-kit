const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const BOND = ethers.parseEther('0.1');
const DAY = 24 * 3600;

async function domain(ledger) {
  return { name: 'AIGGInferenceLedger', version: '1',
    chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await ledger.getAddress() };
}
const TYPES = { Voucher: [
  { name: 'user', type: 'address' }, { name: 'provider', type: 'address' },
  { name: 'nonce', type: 'uint128' }, { name: 'maxFee', type: 'uint256' }, { name: 'expiry', type: 'uint64' } ] };

describe('ServiceRegistry', () => {
  let reg, provider, other;
  beforeEach(async () => {
    [provider, other] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory('ServiceRegistry')).deploy(BOND);
  });
  const args = ['https://gw.example', ['gpt-5', 'claude-opus-4-8'], 100n, 300n,
    ethers.id('quote-blob'), '0x1111111111111111111111111111111111111111', 'dstack-cvm-relay'];

  it('register requires the exact bond', async () => {
    await expect(reg.register(...args, { value: 1n })).to.be.revertedWithCustomError(reg, 'WrongBond');
    await reg.register(...args, { value: BOND });
    const s = await reg.getService(provider.address);
    expect(s.active).to.eq(true); expect(s.inputPriceWei).to.eq(100n);
    expect(await reg.providerCount()).to.eq(1n);
  });
  it('no double-register; update works; deactivate refunds the bond', async () => {
    await reg.register(...args, { value: BOND });
    await expect(reg.register(...args, { value: BOND })).to.be.revertedWithCustomError(reg, 'AlreadyActive');
    await reg.update('https://gw2.example', ['gpt-5'], 120n, 340n, ethers.id('q2'), other.address, 'dstack-cvm-relay');
    expect((await reg.getService(provider.address)).attestedSigner).to.eq(other.address);
    const before = await ethers.provider.getBalance(provider.address);
    const rc = await (await reg.deactivate()).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect(await ethers.provider.getBalance(provider.address)).to.eq(before + BOND - gas);
    expect((await reg.getService(provider.address)).active).to.eq(false);
    await reg.register(...args, { value: BOND });               // re-list after deactivate
    expect(await reg.providerCount()).to.eq(1n);                 // enumeration not duplicated
  });
  it('list() pages', async () => {
    await reg.register(...args, { value: BOND });
    const [addrs, svcs] = await reg.list(0, 10);
    expect(addrs).to.deep.eq([provider.address]); expect(svcs[0].endpoint).to.eq('https://gw.example');
  });
});

describe('InferenceLedger', () => {
  let led, user, prov, mallory;
  beforeEach(async () => {
    [user, prov, mallory] = await ethers.getSigners();
    led = await (await ethers.getContractFactory('InferenceLedger')).deploy();
    await led.deposit({ value: ethers.parseEther('10') });
    await led.transferTo(prov.address, ethers.parseEther('5'));
  });
  const sign = async (signer, v) => signer.signTypedData(await domain(led), TYPES, v);
  const mkV = (nonce, maxFee, expiry) => ({ user: user.address, provider: prov.address, nonce, maxFee, expiry });

  it('deposit → transferTo → batch settle → provider withdraw (full happy path)', async () => {
    const exp = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    const v1 = mkV(0, ethers.parseEther('0.02'), exp), v2 = mkV(1, ethers.parseEther('0.02'), exp);
    const fees = [ethers.parseEther('0.011'), ethers.parseEther('0.007')];
    await led.connect(prov).settle([v1, v2], [await sign(user, v1), await sign(user, v2)], fees);
    expect(await led.balanceOf(user.address, prov.address)).to.eq(ethers.parseEther('5') - fees[0] - fees[1]);
    expect(await led.accrued(prov.address)).to.eq(fees[0] + fees[1]);
    expect(await led.nonceUsed(user.address, prov.address, 0)).to.eq(true);
    const before = await ethers.provider.getBalance(prov.address);
    const rc = await (await led.connect(prov).providerWithdraw()).wait();
    expect(await ethers.provider.getBalance(prov.address)).to.eq(before + fees[0] + fees[1] - rc.gasUsed * rc.gasPrice);
  });
  it('rejects: replay, fee>maxFee, expired, wrong settler, bad signer, overdraft', async () => {
    const exp = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    const v = mkV(7, ethers.parseEther('1'), exp); const sig = await sign(user, v);
    await led.connect(prov).settle([v], [sig], [ethers.parseEther('0.5')]);
    await expect(led.connect(prov).settle([v], [sig], [1n])).to.be.revertedWithCustomError(led, 'NonceUsed');           // replay
    const v2 = mkV(8, 100n, exp);
    await expect(led.connect(prov).settle([v2], [await sign(user, v2)], [101n])).to.be.revertedWithCustomError(led, 'FeeAboveMax');
    const v3 = mkV(9, 100n, 1);
    await expect(led.connect(prov).settle([v3], [await sign(user, v3)], [1n])).to.be.revertedWithCustomError(led, 'VoucherExpired');
    const v4 = mkV(10, 100n, exp);
    await expect(led.connect(mallory).settle([v4], [await sign(user, v4)], [1n])).to.be.revertedWithCustomError(led, 'NotVoucherProvider');
    const v5 = mkV(11, 100n, exp);
    await expect(led.connect(prov).settle([v5], [await sign(mallory, v5)], [1n])).to.be.revertedWithCustomError(led, 'BadSignature'); // signed by wrong key
    const v6 = mkV(12, ethers.parseEther('10'), exp);
    await expect(led.connect(prov).settle([v6], [await sign(user, v6)], [ethers.parseEther('9')])).to.be.revertedWithCustomError(led, 'Insufficient'); // > sub-account
  });
  it('refund: settleable during the 24h window, withdraw pays min(requested, remaining)', async () => {
    await led.requestRefund(prov.address, ethers.parseEther('5'));               // exit everything
    await expect(led.withdrawRefund(prov.address)).to.be.revertedWithCustomError(led, 'RefundLocked');
    const exp = (await ethers.provider.getBlock('latest')).timestamp + 2 * DAY;
    const v = mkV(0, ethers.parseEther('2'), exp);
    await led.connect(prov).settle([v], [await sign(user, v)], [ethers.parseEther('2')]); // provider settles DURING the window
    await network.provider.send('evm_increaseTime', [DAY + 1]); await network.provider.send('evm_mine');
    const before = await ethers.provider.getBalance(user.address);
    const rc = await (await led.withdrawRefund(prov.address)).wait();
    const got = (await ethers.provider.getBalance(user.address)) - before + rc.gasUsed * rc.gasPrice;
    expect(got).to.eq(ethers.parseEther('3'));                                    // min(5 requested, 3 remaining)
    expect(await led.balanceOf(user.address, prov.address)).to.eq(0n);
  });
  it('unallocated funds withdraw instantly; zero/overdraft guarded', async () => {
    await led.withdrawUnallocated(ethers.parseEther('5'));
    await expect(led.withdrawUnallocated(1n)).to.be.revertedWithCustomError(led, 'Insufficient');
    await expect(led.transferTo(prov.address, 1n)).to.be.revertedWithCustomError(led, 'Insufficient');
  });
});
