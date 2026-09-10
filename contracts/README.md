# Exact-input executor

`Executor` executes a caller-selected plan. It does not discover pools, quote,
choose allocations, or optimize routes. Only the transaction caller pays and
receives tokens. Tests run in a local EVM, not on a public network.

## ABI and router identities

Constructor: `constructor(address uniswapRouter_, address pancakeRouter_)`.
Both addresses must contain code and differ. They are immutable, exposed through
`uniswapRouter()` and `pancakeRouter()`. There is no admin, registry update, rescue
function, arbitrary call target, or proxy.

```solidity
struct Hop { address tokenOut; uint24 fee; }
struct Allocation { uint8 venue; uint256 amountIn; Hop[] hops; }

function execute(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minAmountOut,
    uint256 deadline,
    Allocation[] calldata allocations
) external returns (uint256 amountOut);
```

Canonical signature:
`execute(address,address,uint256,uint256,uint256,(uint8,uint256,(address,uint24)[])[])`.
Selector: `0x19b5e3d5`. The function is nonpayable.

- Venue **0** is **Uniswap SwapRouter02**, using the seven-field
  `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`.
  This router call has no deadline field; the executor checks it.
- Venue **1** is **Pancake V3-only SwapRouter**, using the eight-field
  `exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))`.
  The executor also passes its deadline to this router.
- These are fixed ABI identities, not interchangeable V3 routers. In particular,
  the original Uniswap SwapRouter and Pancake Smart Router are not these targets.
  Deployment configuration must verify chain, actual router bytecode and factory
  associations. The constructor checks code existence, not vendor provenance.

Machine-readable ABI: [`abi/Executor.json`](abi/Executor.json).
Creation bytecode after compilation: `out/Executor.sol/Executor.json`.
Golden calldata: [`fixtures/executor-calldata.json`](fixtures/executor-calldata.json).
Amounts and deadlines in fixtures are decimal strings. Addresses are illustrative,
not deployments. `generate-calldata.mjs` derives word offsets independently and
cross-checks the result with `cast calldata`.

## Accepted plans and accounting

- One or two **positive** allocations. If two, their venue IDs must differ.
  Caller order is preserved. Allocation amounts must sum exactly to `amountIn`.
  Subtraction from the remaining total avoids accepting an overflowed sum.
- One or two same-venue hops per allocation. Each hop's input is the top-level
  input or previous hop's output. The last output must equal top-level `tokenOut`.
  Endpoints differ. No self-hop, return to input, early final output, zero address,
  or address without code is accepted. Both routes may share an intermediate.
- Fees are `uint24`; the actual factory/router determines supported pool fees.
  **Fee zero is allowed.** Tests enable it on both authentic factories and swap
  through both authentic routers.
- `block.timestamp == deadline` succeeds; later timestamps fail before token pull.
- Pull exactly `amountIn` from caller, checking both sender and executor deltas.
  Approve exactly each hop's input to its fixed router, call typed
  `exactInputSingle` with executor recipient, then clear that allowance.
- Each hop must consume its entire requested input. Partial consumption reverts
  even if it produced enough output to satisfy the overall minimum. The next hop
  spends **actual received output**, never quoted output, router return value, or
  executor's entire balance. A zero intermediate cannot invoke Uniswap's
  `amountIn=0` router-balance sentinel.
- Router hop minima and price limits are zero. There are **no per-allocation
  floors**. Sum actual final outputs and compare **once** with `minAmountOut`.
  The contract does not calculate slippage or round per-allocation minima.
  Minimum equality succeeds; zero minimum explicitly waives output protection.
- Transfer only new aggregate output to caller and check its received amount.
  Restore all touched executor token balances to their entry values. Existing
  dust is neither spent nor counted toward the minimum. Authentic router tests
  also prove pre-existing router balances remain unchanged.
- Reentrancy protection covers validation, token pull, router calls, approval
  cleanup, and payout. Revert rolls back the entire swap, including prior route
  pool changes. It does not roll back an earlier approval transaction or gas paid.

## Token admission belongs to TOML

The user chose **TOML-only admission before quote-engine work**, not a constructor
allowlist. The contract has no token registry. Application ingress must admit
reviewed standard ERC-20 tokens, including intermediate tokens. Native ETH,
Permit2, transfer-tax, rebasing, and callback-dependent token support are out of
scope. Wrapped native tokens are ordinary ERC-20 only; the executor never unwraps.

Balance-delta checks reject tested transfer-tax cases, but do **not** recognize
every exotic or malicious token. Direct callers can bypass application admission.
Guarantees assume truthful standard ERC-20 balances and the configured authentic
routers. Unsupported tokens can lie about balances or change unrelated balances;
this is not a permissionless token-security classifier. Tokens accidentally sent
to the executor cannot be rescued by an admin.

## Pinned local evidence

Dependencies are pinned in `scripts/testnet/package.json` and `bun.lock`:

- OpenZeppelin Contracts **5.0.2** (`SafeERC20`, `ReentrancyGuard`).
- Uniswap V3 Core **1.0.1** factory/pool artifacts and Swap Router Contracts
  **1.1.0** `SwapRouter02` artifact. Relevant authoritative source:
  [V3SwapRouter v1.1.0](https://github.com/Uniswap/swap-router-contracts/blob/v1.1.0/contracts/V3SwapRouter.sol).
- Pancake V3 Core and Periphery **1.0.2**. The existing preparation script builds
  the bootstrap/core from commit
  [`9868479`](https://github.com/pancakeswap/pancake-v3-contracts/commit/986847948755cba528324d41be19480731c36c2a),
  verifies pool creation hash
  `0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2`,
  and checks compiled pool bytes against the package artifact.

SHA-256 of the exact installed JSON artifacts used by the tests:

| Artifact | SHA-256 |
| --- | --- |
| `@uniswap/v3-core/.../UniswapV3Factory.sol/UniswapV3Factory.json` | `599479f60ebb056804aff7b2d05bdd0830ddbb1fdfaa0b6c62c02294ca7188b0` |
| `@uniswap/swap-router-contracts/.../SwapRouter02.sol/SwapRouter02.json` | `210a7bf29f26de9f45d35dac1214943eca41c3a002007dd6a0e1aa870bf2d2d1` |
| `@pancakeswap/v3-periphery/.../SwapRouter.sol/SwapRouter.json` | `7779cef09158740ed3fa93870444896c5f060d0f852b24343fcdcc5f69246708` |

`test/Executor.t.sol` uses adversarial routers and tokens to prove exact values:
37/64 of 101, actual 81 despite router return 80, shared and separate intermediates,
four touched tokens, deadlines/minimum boundaries, malformed plans, overflow,
partial fills, caller isolation, tax rejection, and reentrancy during pull/router/
payout. The valid-input fuzz test checks independent arithmetic expectations, all
touched executor balances, allocation-specific intermediate spend, and allowances.

`test/ExecutorRouters.t.sol` deploys authentic artifact bytecode in Foundry's local
EVM, seeds real pools, and compares successful executor output with direct router
calls from identical snapshotted pool state. Both venues prove partial first/second
hop rejection, dust preservation, and fee-zero compatibility. The second-venue
failure checks first-pool price/tick state, liquidity, fee growth, token reserves,
and caller balances after rollback. These tests require no RPC or network writes.
They are not proof of a specific public deployment's bytecode or end-to-end
Go/proto/terminal/Tenderly readiness.

## Reproduce

From repository root (dependency install and first preparation may fetch public
packages/source; neither command sends a transaction):

```sh
bun install --frozen-lockfile --ignore-scripts
bun install --cwd scripts/testnet --frozen-lockfile --ignore-scripts
bun scripts/testnet/prepare.mjs
forge test --root contracts -vv
forge test --root contracts --match-test testFuzz --fuzz-runs 10000
forge fmt --check contracts/src/Executor.sol contracts/test/Executor.t.sol contracts/test/ExecutorRouters.t.sol
bun contracts/fixtures/generate-calldata.mjs
forge inspect --root contracts Executor abi --json > contracts/abi/Executor.json
bunx biome check contracts/fixtures contracts/abi
```

Integration must target the executor as spender and transaction destination;
verify both immutable router getters, use exact per-allocation quotes, encode the
golden ABI, simulate that exact transaction, and validate caller/executor/router
token deltas and temporary allowances. The Go/proto/terminal integration and local
Tenderly fixtures implement these checks; see [execution configuration](../docs/execution.md#configured-executor).
The explicitly authorized [Base Sepolia acceptance](../docs/base-sepolia-acceptance.md)
records one deployment's exact runtime correspondence and live Tenderly/execution
proof. Other deployments and production token admission require separate review.
