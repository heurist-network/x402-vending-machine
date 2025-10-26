import { ethers } from "ethers";

const VM_ABI = [
  // reads
  "function vault() view returns (address)",
  "function FAIR_CAP() view returns (uint256)",
  "function launches(uint256) view returns (address creator,address token,uint8 size,uint64 createdAt,uint256 allocated,uint256 targetUSDC,uint256 usdcAccounted,bool graduated)",
  // writes (updated coin & graduate)
  "function coin(string name,string symbol,string initialContractURI,address creator,uint8 size) external returns (uint256 id,address token)",
  "function handlePurchase(uint256 id,address buyer,uint256 usdcAmount) external",
  "function graduate(uint256 id) external",
  "function refund(uint256 id,address buyer) external",
  "function adminRefund(address to, uint256 usdcAmount) external",
  // events
  "event Coined(uint256 indexed id, address token, uint8 size, address creator, string contractURI)",
  "event PurchaseRecorded(uint256 indexed id, address buyer, uint256 usdcAmount, uint256 tokensAllocated)",
  "event Graduated(uint256 indexed id, uint256 usdcIn, uint256 heuOut, uint256 lpBurned)"
];

export const Sizes = { TEST: 0, S: 1, L: 2 } as const;

export type LaunchOnchain = {
  creator: string;
  token: string;
  size: number;
  createdAt: number;
  allocated: bigint;
  targetUSDC: bigint;
  usdcAccounted: bigint;
  graduated: boolean;
};

export async function initContracts() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL_BASE);
  const vmAddress = process.env.VENDING_MACHINE_ADDRESS!;
  const vm = new ethers.Contract(vmAddress, VM_ABI, provider);

  const keys = (process.env.OPERATOR_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length) throw new Error("OPERATOR_KEYS missing");
  const operators = keys.map(k => new ethers.Wallet(k, provider));
  const admin = new ethers.Wallet(process.env.ADMIN_KEY!, provider);
  return { provider, vm, operators, admin };
}

export async function readVault(vm: ethers.Contract) {
  return await vm.vault();
}

export async function readLaunch(vm: ethers.Contract, id: number): Promise<LaunchOnchain> {
  const L = await vm.launches(id);
  return {
    creator: L[0], token: L[1], size: Number(L[2]), createdAt: Number(L[3]),
    allocated: L[4], targetUSDC: L[5], usdcAccounted: L[6], graduated: Boolean(L[7])
  };
}

let rr = 0;
export function pickOperator(vm: ethers.Contract, ops: ethers.Wallet[]) {
  const w = ops[rr % ops.length]; rr++;
  return vm.connect(w);
}
