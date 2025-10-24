// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "openzeppelin-contracts/access/AccessControl.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {X402Token} from "./X402Token.sol";
import {TreasuryVault, ISwapRouter02, IUniswapV2Router02} from "./TreasuryVault.sol";

interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}

contract VendingMachine is AccessControl {
    // --- Roles / Errors
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    error NotOperator();
    error LaunchNotFound();
    error InvalidSize();
    error SalesClosed();
    error CapExceeded();
    error AlreadyGraduated();
    error NotGraduatable();
    error RefundWindowClosed();
    error Zero();
    error OnlyAdmin();
    error NothingToRefund();
    error VaultInsufficient();

    // --- Constants (Base)
    IERC20 public constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913); // 6d
    IERC20 public constant HEU  = IERC20(0xEF22cb48B8483dF6152e1423b19dF5553BbD818b); // 18d
    ISwapRouter02 public constant V3_ROUTER     = ISwapRouter02(0x2626664c2603336E57B271c5C0b26F421741e481);
    IUniswapV2Router02 public constant V2_ROUTER= IUniswapV2Router02(0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24);
    IUniswapV2Factory  public constant V2_FACTORY = IUniswapV2Factory(0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6);

    // Prices (tokens per 1 USDC in 6d units)
    uint256 private constant TOKENS_PER_USDC_TEST_6D = 200_000_000 * 1e12; // test
    uint256 private constant TOKENS_PER_USDC_S_6D    = 200_000 * 1e12;     // Small
    uint256 private constant TOKENS_PER_USDC_L_6D    =  20_000 * 1e12;     // Large

    enum Size { TEST, S, L }

    struct Launch {
        address creator;     // ERC-7572 setter
        address token;       // X402Token
        Size size;
        uint24 v3Fee;
        uint64 createdAt;

        // accounting
        uint256 fairCap;         // 900M (18d)
        uint256 allocated;       // total allocated to buyers (18d)
        uint256 targetUSDC;      // 4,500e6 (S) or 45,000e6 (L)
        uint256 usdcAccounted;   // sum of contributions for this launch (6d)
        bool    graduated;
    }

    // --- Global single vault (x402 payTo)
    address public immutable vault;

    // --- Per-launch buyer state
    mapping(uint256 => mapping(address => uint256)) public contributions6d; // USDC (6d)
    mapping(uint256 => mapping(address => uint256)) public allocations;     // tokens (18d)
    mapping(uint256 => Launch) public launches;
    mapping(address => uint256) public launchByToken;
    uint256 public nextLaunchId;

    // --- Global accounting for solvency checks against pooled vault
    uint256 public usdcAccountedTotal;  // sum over launches (6d)

    // --- Events
    event Coined(uint256 indexed id, address token, Size size, address creator, uint24 v3Fee, string contractURI);
    event PurchaseRecorded(uint256 indexed id, address buyer, uint256 usdcAmount, uint256 tokensAllocated);
    event Graduated(uint256 indexed id, uint256 usdcIn, uint256 heuOut, uint256 lpBurned);
    event Claimed(uint256 indexed id, address buyer, uint256 tokens);
    event Refunded(uint256 indexed id, address buyer, uint256 usdcAmount);
    event EmergencyWithdrawn(uint256 usdcAmount, address to);

    constructor(address admin, address initialOperator) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (initialOperator != address(0)) _grantRole(OPERATOR_ROLE, initialOperator);

        // deploy the shared vault; set owner = this vending machine
        address v = address(new TreasuryVault(address(this)));
        vault = v;
    }

    // --- Helpers
    modifier onlyOp(){ if (!hasRole(OPERATOR_ROLE, msg.sender)) revert NotOperator(); _; }
    function _get(uint256 id) internal view returns (Launch storage L) {
        L = launches[id]; if (L.token == address(0)) revert LaunchNotFound();
    }

    // --- Factory: coin (deploy token, no per-launch vault)
    function coin(
        string memory name_,
        string memory symbol_,
        string memory initialContractURI,
        address creator,
        Size size,
        uint24 v3Fee
    ) external onlyOp returns (uint256 id, address token) {
        if (size != Size.S && size != Size.L && size != Size.TEST) revert InvalidSize();

        id = ++nextLaunchId;

        token = address(new X402Token(
            name_, symbol_,
            1_000_000_000e18,  // 1B max
            address(this),     // admin
            address(this),     // minter
            address(this),     // burner
            creator,           // ERC-7572 setter
            initialContractURI
        ));

        Launch storage L = launches[id];
        L.creator   = creator;
        L.token     = token;
        L.size      = size;
        L.v3Fee     = v3Fee;
        L.createdAt = uint64(block.timestamp);
        L.fairCap   = 900_000_000e18;
        // TEST = 4.5 USDC, S = 4500 USDC, L = 45000 USDC
        L.targetUSDC= (size == Size.TEST) ? 4_500_000 : (size == Size.S) ? 4_500e6 : 45_000e6;

        launchByToken[token] = id;

        emit Coined(id, token, size, creator, v3Fee, initialContractURI);
    }

    // --- Settlement hook (operator): record contribution + allocation (no mint yet)
    function handlePurchase(uint256 id, address buyer, uint256 usdcAmount) external onlyOp {
        if (usdcAmount == 0) revert Zero();
        Launch storage L = _get(id);
        if (L.graduated) revert SalesClosed();

        // Global solvency check against pooled vault
        uint256 bal = USDC.balanceOf(vault);
        if (usdcAccountedTotal + usdcAmount > bal) revert VaultInsufficient();

        uint256 perUSDC =
            (L.size == Size.TEST) ? TOKENS_PER_USDC_TEST_6D :
            (L.size == Size.S)    ? TOKENS_PER_USDC_S_6D    :
                                    TOKENS_PER_USDC_L_6D;
        uint256 tokens = usdcAmount * perUSDC;

        if (L.allocated + tokens > L.fairCap) revert CapExceeded();

        contributions6d[id][buyer] += usdcAmount;
        allocations[id][buyer]     += tokens;
        L.usdcAccounted            += usdcAmount;
        L.allocated                += tokens;
        usdcAccountedTotal         += usdcAmount;

        X402Token(L.token).mint(buyer, tokens);

        emit PurchaseRecorded(id, buyer, usdcAmount, tokens);
    }

    // Optional batch helper (unchanged logic; pooled solvency)
    function handleBatchPurchase(uint256 id, address[] calldata buyers, uint256 usdcAmount) external onlyOp {
        if (usdcAmount == 0 || buyers.length == 0) revert Zero();
        Launch storage L = _get(id);
        if (L.graduated) revert SalesClosed();

        uint256 totalAmount = usdcAmount * buyers.length;
        uint256 bal = USDC.balanceOf(vault);
        if (usdcAccountedTotal + totalAmount > bal) revert VaultInsufficient();

        uint256 perUSDC =
            (L.size == Size.TEST) ? TOKENS_PER_USDC_TEST_6D :
            (L.size == Size.S)    ? TOKENS_PER_USDC_S_6D    :
                                    TOKENS_PER_USDC_L_6D;
        uint256 tokensPerBuyer = usdcAmount * perUSDC;
        uint256 totalTokens    = tokensPerBuyer * buyers.length;

        if (L.allocated + totalTokens > L.fairCap) revert CapExceeded();

        L.usdcAccounted += totalAmount;
        L.allocated     += totalTokens;
        usdcAccountedTotal += totalAmount;

        for (uint256 i = 0; i < buyers.length; i++) {
            address b = buyers[i];
            contributions6d[id][b] += usdcAmount;
            allocations[id][b]     += tokensPerBuyer;
            X402Token(L.token).mint(b, tokensPerBuyer);
            emit PurchaseRecorded(id, b, usdcAmount, tokensPerBuyer);
        }
    }

    // --- Graduate (anyone): only when EXACTLY 900M allocated
    function graduate(uint256 id, uint256 minHeuOut, uint256 minTokenForLP, uint256 minHeuForLP) external {
        Launch storage L = _get(id);
        if (L.graduated) revert AlreadyGraduated();
        if (L.allocated != L.fairCap) revert NotGraduatable();

        uint256 usdcIn = L.usdcAccounted;
        if (usdcIn == 0 || USDC.balanceOf(vault) < usdcIn) revert VaultInsufficient();

        TreasuryVault(vault).swapUSDCforHEU(
            V3_ROUTER, USDC, HEU, L.v3Fee, usdcIn, minHeuOut
        );
        // keep the vault's HEU; decrease the pooled accounting
        usdcAccountedTotal -= usdcIn;
        L.usdcAccounted = 0;

        // Mint 100M to vault, then add v2 liquidity with ALL HEU acquired
        X402Token(L.token).mint(vault, 100_000_000e18);
        uint256 heuBal = HEU.balanceOf(vault);
        TreasuryVault(vault).addLiquidityV2(
            V2_ROUTER, IERC20(L.token), HEU,
            100_000_000e18, heuBal,
            minTokenForLP, minHeuForLP
        );

        X402Token(L.token).enableTransfers();
        L.graduated = true;
        emit Graduated(id, usdcIn, heuBal, 0);
    }

    // --- Refund window predicate (by token address)
    function refundable(address tokenAddress) external view returns (bool) {
        uint256 id = launchByToken[tokenAddress];
        if (id == 0) return false;
        Launch storage L = launches[id];
        if (L.graduated) return false;
        return block.timestamp > L.createdAt + 14 days;
    }

    // --- Refund buyer (operator), after 14 days if not graduated
    function refund(uint256 id, address buyer) external onlyOp {
        Launch storage L = _get(id);
        if (L.graduated) revert RefundWindowClosed();
        if (block.timestamp <= L.createdAt + 14 days) revert RefundWindowClosed();

        uint256 amt = contributions6d[id][buyer];
        if (amt == 0) revert NothingToRefund();

        // Effects first
        contributions6d[id][buyer] = 0;
        uint256 alloc = allocations[id][buyer];
        allocations[id][buyer] = 0;

        L.usdcAccounted     -= amt;
        usdcAccountedTotal  -= amt;
        L.allocated         -= alloc;

        // burn already-minted tokens (only pre-graduation allowed)
        X402Token(L.token).burn(buyer, alloc);

        // pay back USDC
        TreasuryVault(vault).pull(USDC, buyer, amt);

        emit Refunded(id, buyer, amt);
    }

    function adminRefund(address to, uint256 usdcAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // does NOT touch any launch accounting. intended for off-chain tracked anomalies
        TreasuryVault(vault).pull(USDC, to, usdcAmount);
    }

    function emergencyWithdrawUSDC(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 bal = USDC.balanceOf(vault);
        TreasuryVault(vault).pull(USDC, to, bal);
        emit EmergencyWithdrawn(bal, to);
    }
}
