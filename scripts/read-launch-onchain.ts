import { formatUnits } from "ethers";
import { argString, log, parseArgs } from "./script-utils";
import { initContracts, readLaunch } from "../src/web3";

async function main() {
  const args = parseArgs();
  const onchainIdInput = argString(args, "id") || process.env.ONCHAIN_ID || "1";
  const onchainId = Number(onchainIdInput);

  log.info({ onchainId }, "Reading launch from blockchain");

  const { vm } = await initContracts();
  const launch = await readLaunch(vm, onchainId);

  // Map size number to name
  const sizeNames = ["TEST", "S", "L"];
  const sizeName = sizeNames[launch.size] || `Unknown(${launch.size})`;

  log.info({
    onchainId,
    token: launch.token,
    creator: launch.creator,
    size: sizeName,
    createdAt: new Date(launch.createdAt * 1000).toISOString(),
    allocated: formatUnits(launch.allocated, 18),
    targetUSDC: formatUnits(launch.targetUSDC, 6),
    usdcAccounted: formatUnits(launch.usdcAccounted, 6),
    graduated: launch.graduated
  }, "Launch data");
}

main().catch((err) => {
  log.error({ err }, "read-launch-onchain script error");
  process.exit(1);
});
