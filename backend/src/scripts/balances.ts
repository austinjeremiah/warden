import { ethers } from 'ethers';
import { crooEndpoints, optional } from '../shared/env.js';

/** Read on-chain USDC balances for all agent wallets. Read-only. */
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base mainnet USDC (6 decimals)

const WALLETS: { tag: string; env: string }[] = [
  { tag: 'Buyer', env: 'BUYER_AA_WALLET' },
  { tag: 'Warden', env: 'WARDEN_AA_WALLET' },
  { tag: 'Provider A', env: 'PROVIDER_A_AA_WALLET' },
  { tag: 'Provider B', env: 'PROVIDER_B_AA_WALLET' },
];

async function main() {
  const provider = new ethers.JsonRpcProvider(crooEndpoints.rpcURL);
  const erc20 = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
  console.log('--- USDC balances (Base mainnet) ---');
  for (const w of WALLETS) {
    const addr = optional(w.env);
    if (!addr) {
      console.log(`${w.tag.padEnd(11)}: (no address)`);
      continue;
    }
    const bal = await erc20.balanceOf(addr);
    console.log(`${w.tag.padEnd(11)}: ${ethers.formatUnits(bal, 6)} USDC   ${addr}`);
  }
}

main().catch((e) => {
  console.error('BALANCE CHECK FAILED:', e);
  process.exit(1);
});
