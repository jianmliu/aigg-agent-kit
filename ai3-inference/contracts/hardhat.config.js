require('@nomicfoundation/hardhat-chai-matchers');
require('@nomicfoundation/hardhat-ethers');

// Auto EVM accepts legacy (type-0) transactions only — the deploy script pins an
// explicit gasPrice on every send instead of EIP-1559 fields (see deploy/deploy.js).
// AI3_DEPLOYER_KEY funds the deploy on live networks; never commit it.
const accounts = process.env.AI3_DEPLOYER_KEY ? [process.env.AI3_DEPLOYER_KEY] : [];

module.exports = {
  solidity: { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
  paths: { sources: './src', tests: './test-hh', cache: './cache-hh', artifacts: './artifacts' },
  networks: {
    // local node (anvil or `hardhat node`) for the deploy-script verification gate
    localhost: { url: process.env.AI3_RPC_URL || 'http://127.0.0.1:8545' },
    chronos: {
      url: process.env.AI3_CHRONOS_RPC || 'https://auto-evm.chronos.autonomys.xyz/ws',
      chainId: 8700, // tAI3
      accounts,
    },
    autoEvmMainnet: {
      url: process.env.AI3_MAINNET_RPC || 'https://auto-evm.mainnet.autonomys.xyz/ws',
      chainId: 870, // AI3
      accounts,
    },
  },
};
