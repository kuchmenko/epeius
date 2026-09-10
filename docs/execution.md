# Testnet execution contract

Epeius's first execution milestone uses direct Uniswap V3 and Pancake V3 router calls on Base Sepolia (chain ID 84532). The Go engine builds and simulates unsigned transactions. The terminal owns the local signer, confirmation, submission, and receipt checks. Mainnet execution is disabled.

## Routes and deployments

A route uses one configured deployment and one or two pools. Each hop names the pool, input token, output token, and pool selector. Uniswap V3 and Pancake V3 use `fee_pips`, measured in millionths. Slipstream uses signed `tick_spacing`, which is not a fee; its execution is outside this milestone.

For example, an A-to-C quote can offer a direct Uniswap A/C pool, a two-hop Uniswap A/B and B/C route, and a separate Pancake route. These are alternatives, not sequential trades. The second hop consumes the actual output of the first hop, not an independently fixed estimate. Split execution across venues is deferred.

Pool addresses and parameters must match the configured factory. Router addresses come from configuration, not user-supplied transaction targets. Native ETH swaps, transfer-tax tokens, rebasing tokens, Permit2, and arbitrary calldata execution are unsupported.

## Quotes and immutable preparations

An informational quote does not need a wallet and does not authorize execution. A preparation binds one selected quote to the sender, recipient, amount, route, minimum output, deadline, and unsigned transaction. The sender and recipient are the same wallet in this milestone.

Rechecking a preparation can update the simulation result, but cannot silently change the transaction's conditions. Changing the route, minimum output, or deadline requires a new preparation and confirmation. Preparations are held in memory; restarting the engine invalidates their identifiers.

Application expiry and the on-chain deadline have different jobs. Application expiry limits how long the terminal accepts a preparation. The router checks the deadline against the block timestamp. Neither reserves pool liquidity or guarantees inclusion before expiry.

Uniswap SwapRouter02's V3 swap tuples do not include a deadline. Its trusted `multicall(uint256,bytes[])` wrapper supplies that check. This router-local wrapper is not a new generic multicall contract. Pancake V3 includes a deadline in its swap parameters.

## Approval is a separate transaction

If the wallet's allowance is insufficient, the engine reports `APPROVAL_REQUIRED`. A simulated approval followed by a swap is a preview, not proof that the real wallet is ready to swap.

The user confirms the approval separately. After its receipt, obtain a fresh quote and a fresh swap preparation, then confirm that swap separately. A successful approval is not rolled back if the later swap fails. Do not silently substitute a different route after approval.

## What simulation proves

Tenderly simulates the actual sender, target, calldata, and value against a specified network state. A ready preparation must use real balances and allowances, without state overrides that manufacture readiness. Missing or inconclusive simulation evidence is not success.

Every bundle step sets `transaction_index = -1` to start from the pinned block's end state, matching the RPC reads. Omitting that field uses the block's starting state: an approval confirmed within that block can appear absent in simulation. This distinction was verified on Base Sepolia by comparing the same allowance before the block, after the block, and at explicit Tenderly transaction indexes. Bundle steps then carry simulated state forward in order.

Check that the transaction succeeds, consumes the declared input, delivers at least the minimum output, and introduces no intermediate-token residue in the router. For custom test tokens, use exact token amounts and balance/transfer evidence; USD valuations are neither required nor proof of correctness.

Simulate alternative routes separately from the same starting block. A sequential bundle carries earlier state changes into later calls, so it is suitable for approval followed by swap, but not for comparing independent alternatives.

Simulation does not guarantee future success. Other transactions can change pool state before inclusion. RPC or simulator failure must not silently bypass the pre-send check.

## Known limitation: partial input consumption

`amountOutMinimum` constrains the output, not full input consumption. A V3 pool can reach its limiting price before consuming all requested input. If the output still satisfies the minimum, the router call can succeed.

In an ordinary single-hop swap paid directly from the wallet, unconsumed input stays in the wallet. For a two-hop swap, intermediate tokens can instead remain in the router. For example, the first hop can exchange 100 A for 80 B, while the second hop consumes only 60 B. The remaining 20 B can stay in the router even though the transaction succeeds.

This milestone checks consumption before submission through simulation and after execution through actual transaction evidence. It does **not** enforce an on-chain full-consumption-or-revert guarantee. A change in pool state between simulation and inclusion can still produce an unexpected result. A post-execution failure report cannot undo a confirmed trade or automatically recover stranded tokens.

The terminal must distinguish a confirmed successful receipt from a trade whose amounts passed verification. Neither a successful receipt nor the final output balance alone proves full input and intermediate-token consumption. Existing router balances must not be counted as this trade's output or residue.

Base RPC can return a preliminary receipt with `status = 1` and an all-zero `blockHash` before the block is sealed. That is not confirmed execution. Wait for a nonzero block hash that matches the canonical block at the receipt's block number before checking amounts or using newly deployed contracts. This check is not a claim of L1 finality; later reorgs remain possible.

## Future executor guarantee

The future typed executor will receive the intermediate tokens itself and measure consumption at each hop. Incomplete input or intermediate-token consumption will revert the entire swap transaction. It will preserve balances that existed before the trade and clear its router allowances.

A revert rolls back that transaction's swaps and token transfers. Gas is still paid, and an earlier approval transaction remains confirmed. The same executor call will be used for simulation and actual execution; a simulation-only wrapper would not establish the same guarantee.

The executor will support fixed allocations across two venues without arbitrary targets or delegatecalls. It is not part of the direct-router milestone.

## Public testnet checks

Use separate harness and terminal wallets, with small Base Sepolia-only balances. Keep encrypted keystores and password files outside Git. Local file permissions and encryption do not protect against compromise of the same OS account when the password is stored on that machine.

The harness uses standard mintable tokens with 18, 6, and 8 decimals. Real one-hop and two-hop swaps on both venues, approval handling, opposite directions, partial consumption, and intermediate residues are separate checks. Network transactions require explicit opt-in; credential-free checks must not deploy or spend test ETH.

Public testnet transactions change pool state and cannot be reset by the harness. Sequential trades need not have equal outputs. Record the selected route, preparation, block context, transaction hash, and verification result; do not describe successful testnet execution as a mainnet result.

## References

- [Uniswap SwapRouter02 V3 interface](https://github.com/Uniswap/swap-router-contracts/blob/v1.1.0/contracts/interfaces/IV3SwapRouter.sol)
- [Uniswap deadline multicall](https://github.com/Uniswap/swap-router-contracts/blob/v1.1.0/contracts/base/MulticallExtended.sol)
- [Uniswap V3 router implementation](https://github.com/Uniswap/swap-router-contracts/blob/v1.1.0/contracts/V3SwapRouter.sol)
- [Tenderly sequential bundle semantics](https://docs.tenderly.co/api-reference/simulator/simulate-bundled-transactions)
- [Tenderly Base Sepolia simulation](https://docs.tenderly.co/node/rpc-reference/base-sepolia/tenderly_simulateBundle)
