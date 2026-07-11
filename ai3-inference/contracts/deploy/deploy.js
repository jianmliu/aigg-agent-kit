/**
 * Deploy ServiceRegistry(bondWei) + InferenceLedger and record the addresses in
 * ../addresses.json keyed by chainId.
 *
 *   pnpm --filter @ai3-inference/contracts deploy:local     # against anvil / hardhat node
 *   AI3_DEPLOYER_KEY=0x… pnpm --filter @ai3-inference/contracts deploy:chronos
 *
 * Env:
 *   AI3_REGISTRY_BOND   listing bond in AI3 (default "0.1"); immutable after deploy
 *   AI3_DEPLOYER_KEY    funded key for live networks (hardhat.config.js)
 *
 * Every send pins an explicit gasPrice so the transactions are legacy type-0 —
 * Auto EVM rejects EIP-1559 fields.
 */
const fs = require('fs');
const path = require('path');
const { ethers, network } = require('hardhat');

const ADDRESSES = path.join(__dirname, '..', 'addresses.json');

async function main() {
  const bondWei = ethers.parseEther(process.env.AI3_REGISTRY_BOND || '0.1');
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('no deployer account — set AI3_DEPLOYER_KEY for live networks');
  const { chainId } = await ethers.provider.getNetwork();
  const { gasPrice } = await ethers.provider.getFeeData();
  if (gasPrice == null) throw new Error('node returned no gasPrice — cannot form a legacy tx');
  const overrides = { gasPrice, type: 0 };

  console.log(`network=${network.name} chainId=${chainId} deployer=${deployer.address} bond=${ethers.formatEther(bondWei)} AI3`);

  const registry = await (await ethers.getContractFactory('ServiceRegistry')).deploy(bondWei, overrides);
  await registry.waitForDeployment();
  const ledger = await (await ethers.getContractFactory('InferenceLedger')).deploy(overrides);
  await ledger.waitForDeployment();

  const entry = {
    chain: network.name,
    serviceRegistry: await registry.getAddress(),
    inferenceLedger: await ledger.getAddress(),
    bondWei: bondWei.toString(),
    deployer: deployer.address,
    block: await ethers.provider.getBlockNumber(),
  };
  const book = fs.existsSync(ADDRESSES) ? JSON.parse(fs.readFileSync(ADDRESSES, 'utf8')) : {};
  book[String(chainId)] = entry;
  fs.writeFileSync(ADDRESSES, JSON.stringify(book, null, 2) + '\n');
  console.log(`ServiceRegistry  ${entry.serviceRegistry}`);
  console.log(`InferenceLedger  ${entry.inferenceLedger}`);
  console.log(`recorded → ${path.relative(process.cwd(), ADDRESSES)} ["${chainId}"]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
