import {
  type AbiParameter,
  type Address,
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHash,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { executorV2Abi } from "../../../../generated/abi";
import type {
  PlanProgram,
  PoolOperation,
} from "../../../../generated/ts/epeius/atomic/v1/atomic_pb";
import type { PrepareExecutionResponse } from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { type SwapTerms, uint256Decimal } from "../execution-policy";
import { admitV3Route, type V3Deployment, v3Review } from "./v3";

type AtomicOperation = {
  kind: number;
  tokenOut: Address;
  fee: number;
  tickSpacing: number;
  poolId: `0x${string}`;
};

type AtomicBranch = {
  amountIn: bigint;
  minAmountOut: bigint;
  operations: readonly AtomicOperation[];
};

export type AtomicExecutorPlan = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  branches: readonly AtomicBranch[];
};

const operationComponents = [
  { name: "kind", type: "uint8" },
  { name: "tokenOut", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "poolId", type: "bytes32" },
] as const;
const branchComponents = [
  { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" },
  { name: "operations", type: "tuple[]", components: operationComponents },
] as const;
const planParameter = {
  name: "plan",
  type: "tuple",
  components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "branches", type: "tuple[]", components: branchComponents },
  ],
} as const satisfies AbiParameter;

const domain = (value: string) => keccak256(stringToHex(value));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const requiredBytes = (
  value: Uint8Array | undefined,
  size: number,
  label: string,
) => {
  if (!value || value.length !== size)
    throw new Error(`Atomic V1 ${label} has the wrong width.`);
  return bytesToHex(value);
};
const requiredUint = (value: Uint8Array | undefined, label: string) =>
  BigInt(requiredBytes(value, 32, label));

const atomicPool = (operation: PoolOperation) => {
  if (operation.pool.case === "uniswapV3")
    return {
      pool: operation.pool.value,
      kind: 1,
      selector: operation.pool.value.feePips,
      selectorType: "uint24" as const,
    };
  if (operation.pool.case === "pancakeV3")
    return {
      pool: operation.pool.value,
      kind: 2,
      selector: operation.pool.value.feePips,
      selectorType: "uint24" as const,
    };
  if (operation.pool.case === "slipstreamInitial")
    return {
      pool: operation.pool.value,
      kind: 3,
      selector: operation.pool.value.tickSpacing,
      selectorType: "int24" as const,
    };
  throw new Error("Atomic V1 accepted operation is unsupported.");
};

function rejectUnknownFields(value: unknown) {
  if (!value || typeof value !== "object" || value instanceof Uint8Array)
    return;
  const message = value as { $unknown?: unknown[] };
  if (message.$unknown?.length)
    throw new Error("Atomic V1 plan contains unsupported fields.");
  for (const child of Object.values(value)) rejectUnknownFields(child);
}

export function atomicV1PlanId(terms: {
  chainId: bigint;
  executor: Address;
  runtimeCodeHash: `0x${string}`;
  signer: Address;
  recipient: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minimum: bigint;
  quoteBlockNumber: bigint;
  quoteBlockHash: `0x${string}`;
  expiresAt: bigint;
  deadline: bigint;
  branchHashes: readonly `0x${string}`[];
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32[]" },
      ],
      [
        domain("Epeius.AtomicPlan.v1"),
        1,
        terms.chainId,
        terms.executor,
        2,
        terms.runtimeCodeHash,
        terms.signer,
        terms.recipient,
        terms.tokenIn,
        terms.tokenOut,
        terms.amountIn,
        terms.minimum,
        terms.quoteBlockNumber,
        terms.quoteBlockHash,
        terms.expiresAt,
        terms.deadline,
        [...terms.branchHashes],
      ],
    ),
  );
}

export function atomicV1TransactionFingerprint(terms: {
  planId: `0x${string}`;
  chainId: bigint;
  from: Address;
  to: Address;
  value: bigint;
  data: `0x${string}`;
  gasLimit: bigint;
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        domain("Epeius.AtomicTransaction.v1"),
        terms.planId,
        terms.chainId,
        terms.from,
        terms.to,
        terms.value,
        keccak256(terms.data),
        terms.gasLimit,
      ],
    ),
  );
}

export function atomicV1ExecutorPlanHash(terms: {
  chainId: bigint;
  executor: Address;
  sender: Address;
  plan: AtomicExecutorPlan;
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        planParameter,
      ],
      [2n, terms.chainId, terms.executor, terms.sender, terms.plan],
    ),
  );
}

export function atomicV1ExecutorCalldata(plan: AtomicExecutorPlan) {
  return encodeFunctionData({
    abi: executorV2Abi,
    functionName: "execute",
    args: [plan],
  });
}

export function atomicV1AcceptedBranchHashes(
  program: PlanProgram,
  minima: readonly bigint[],
) {
  if (program.branches.length !== minima.length)
    throw new Error("Atomic V1 accepted branch cardinality is invalid.");
  return program.branches.map((branch, branchIndex) => {
    const operationHashes = branch.operations.map((operation) => {
      const { pool, kind, selector, selectorType } = atomicPool(operation);
      if (selector === undefined)
        throw new Error("Atomic V1 accepted operation is unsupported.");
      const providerHash = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint8" },
            { type: "address" },
            { type: "address" },
            { type: "address" },
            { type: selectorType },
          ],
          [
            domain("Epeius.AtomicProvider.v1"),
            kind,
            getAddress(requiredBytes(pool.factory, 20, "factory")),
            getAddress(requiredBytes(pool.router, 20, "router")),
            getAddress(requiredBytes(pool.pool, 20, "pool")),
            selector,
          ],
        ),
      );
      return keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint8" },
            { type: "address" },
            { type: "address" },
            { type: "bytes32" },
          ],
          [
            domain("Epeius.AtomicOperation.v1"),
            kind,
            getAddress(requiredBytes(operation.tokenIn, 20, "operation input")),
            getAddress(
              requiredBytes(operation.tokenOut, 20, "operation output"),
            ),
            providerHash,
          ],
        ),
      );
    });
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32[]" },
        ],
        [
          domain("Epeius.AtomicAcceptedBranch.v1"),
          requiredUint(branch.amountIn, "branch input"),
          minima[branchIndex],
          operationHashes,
        ],
      ),
    );
  });
}

export function atomicExecutorV1(
  raw: {
    address?: string;
    runtimeCodeHash?: string;
    uniswapDeployment?: string;
    pancakeDeployment?: string;
    slipstreamDeployment?: string;
  },
  deployments: Record<string, { kind: string }>,
) {
  const configuredAddress = `0x${raw.address?.replace(/^0x/i, "") ?? ""}`;
  if (
    !isAddress(configuredAddress, { strict: false }) ||
    getAddress(configuredAddress) === zeroAddress ||
    !/^(?:0x)?[0-9a-f]{64}$/i.test(raw.runtimeCodeHash ?? "")
  )
    throw new Error("Local Atomic V1 executor identity is invalid.");
  const address = getAddress(configuredAddress).toLowerCase() as Address;
  const runtimeCodeHash = `0x${raw.runtimeCodeHash?.replace(/^0x/i, "").toLowerCase()}`;
  const uniswap = raw.uniswapDeployment
    ? (deployments[raw.uniswapDeployment] as V3Deployment | undefined)
    : undefined;
  const pancake = raw.pancakeDeployment
    ? (deployments[raw.pancakeDeployment] as V3Deployment | undefined)
    : undefined;
  const slipstream = raw.slipstreamDeployment
    ? (deployments[raw.slipstreamDeployment] as
        | {
            kind: string;
            factory?: string;
            router: string;
            tickSpacings: number[];
          }
        | undefined)
    : undefined;
  if (
    (raw.uniswapDeployment && uniswap?.kind !== "uniswap-v3") ||
    (raw.pancakeDeployment && pancake?.kind !== "pancake-v3") ||
    (raw.slipstreamDeployment && slipstream?.kind !== "aerodrome-slipstream") ||
    (!uniswap && !pancake && !slipstream) ||
    [uniswap, pancake, slipstream].some((value) => value && !value.factory) ||
    new Set(
      [uniswap, pancake, slipstream]
        .filter(Boolean)
        .map((value) => value?.router.toLowerCase()),
    ).size !== [uniswap, pancake, slipstream].filter(Boolean).length
  )
    throw new Error(
      "Local Atomic V1 executor needs at least one valid deployment with distinct routers.",
    );
  const deployment = uniswap ?? pancake ?? slipstream;
  if (!deployment?.factory) throw new Error("Invalid Atomic V1 deployment.");
  const factory = deployment.factory;

  return {
    address,
    runtimeCodeHash,
    factory,
    router: deployment.router,
    pancakeFactory: pancake?.factory,
    pancakeRouter: pancake?.router,
    slipstreamFactory: slipstream?.factory,
    slipstreamRouter: slipstream?.router,
    plan(
      p: PrepareExecutionResponse,
      tokens: string[],
      slippageBps: number,
    ): SwapTerms {
      const wirePlan = p.atomicPlan;
      const selected = p.route
        ? [{ amountInAtomic: p.amountInAtomic, route: p.route }]
        : p.allocations;
      const single =
        !!p.route &&
        p.allocations.length === 0 &&
        p.route.legs.length >= 1 &&
        p.route.legs.length <= 2;
      const split =
        !p.route &&
        p.allocations.length === 2 &&
        p.allocations.every(
          (allocation) => allocation.route?.legs.length === 1,
        );
      if (!wirePlan || (!single && !split))
        throw new Error("Invalid Atomic V1 plan.");
      const routes = selected.map((selection) => {
        if (!selection.route || !uniswap)
          throw new Error("Invalid Atomic V1 plan.");
        admitV3Route(selection.route, p, uniswap, tokens);
        return selection.route;
      });
      const block = routes[0].block;
      if (
        !block ||
        !isHash(block.hash) ||
        !/^[0-9]+$/.test(block.number) ||
        routes.some(
          (route) =>
            !route.block ||
            route.block.number !== block.number ||
            !same(route.block.hash, block.hash),
        )
      )
        throw new Error("Atomic V1 routes must share one pinned block.");
      const legs = routes.flatMap((route) => route.legs);
      const poolAddresses = legs.map((leg) => leg.pool.toLowerCase());
      const poolKeys = legs.map((leg) => {
        const [token0, token1] = [leg.tokenIn, leg.tokenOut]
          .map((token) => token.toLowerCase())
          .sort();
        return `${token0}:${token1}:${leg.selector.value}`;
      });
      if (
        new Set(poolAddresses).size !== poolAddresses.length ||
        new Set(poolKeys).size !== poolKeys.length
      )
        throw new Error("Atomic V1 operations must use distinct pools.");
      if (
        wirePlan.branches.length !== selected.length ||
        wirePlan.branches.some(
          (branch, i) => branch.operations.length !== routes[i].legs.length,
        )
      )
        throw new Error(
          "Atomic V1 requires one branch with up to two operations or two direct branches.",
        );
      const accepted = wirePlan.acceptedTerms;
      const program = accepted?.program;
      const quoteBlock = accepted?.quoteBlock;
      const acceptedExecutor = accepted?.executor;
      rejectUnknownFields(wirePlan);
      if (
        !accepted ||
        !program ||
        !quoteBlock ||
        !acceptedExecutor ||
        program.formatVersion !== 1 ||
        program.branches.length !== selected.length ||
        program.branches.some(
          (branch, i) => branch.operations.length !== routes[i].legs.length,
        ) ||
        accepted.branchMinima.length !== selected.length ||
        acceptedExecutor.version !== 2 ||
        program.branches.some((branch) =>
          branch.operations.some(
            (operation) =>
              operation.pool.case !== "uniswapV3" ||
              operation.pool.value.feePips === undefined,
          ),
        ) ||
        !wirePlan.planId ||
        wirePlan.planId.length !== 32 ||
        !wirePlan.transactionFingerprint ||
        wirePlan.transactionFingerprint.length !== 32
      )
        throw new Error("Invalid Atomic V1 accepted terms.");
      const swapChainId =
        p.transaction?.chainId ??
        p.approvalTransaction?.chainId ??
        p.onChainPermission?.transaction?.chainId;
      if (
        !isHash(wirePlan.executorPlanHash) ||
        wirePlan.chainId !== swapChainId ||
        !same(wirePlan.executor, address) ||
        !same(wirePlan.sender, p.recipient) ||
        !same(wirePlan.tokenIn, p.tokenIn) ||
        !same(wirePlan.tokenOut, p.tokenOut) ||
        wirePlan.amountInAtomic !== p.amountInAtomic ||
        wirePlan.amountOutMinimumAtomic !== p.amountOutMinimumAtomic ||
        wirePlan.deadlineUnix !== p.deadlineUnix ||
        wirePlan.branches.some((branch, branchIndex) => {
          const selectedBranch = selected[branchIndex];
          const expectedMinimum = single
            ? p.amountOutMinimumAtomic
            : (
                (uint256Decimal(
                  routes[branchIndex].amountOutAtomic,
                  "Route quoted output",
                ) *
                  BigInt(10000 - slippageBps)) /
                10000n
              ).toString();
          return (
            branch.amountInAtomic !== selectedBranch.amountInAtomic ||
            branch.amountOutMinimumAtomic !== expectedMinimum ||
            branch.operations.some((operation, operationIndex) => {
              const leg = routes[branchIndex].legs[operationIndex];
              return (
                operation.kind !== 1 ||
                !same(operation.tokenOut, leg.tokenOut) ||
                operation.feePips !== leg.selector.value ||
                operation.tickSpacing !== 0 ||
                !same(operation.poolId, zeroHash)
              );
            })
          );
        })
      )
        throw new Error("Atomic V1 plan differs from prepared route terms.");
      const plan: AtomicExecutorPlan = {
        tokenIn: getAddress(wirePlan.tokenIn),
        tokenOut: getAddress(wirePlan.tokenOut),
        amountIn: uint256Decimal(wirePlan.amountInAtomic, "Input amount"),
        minAmountOut: uint256Decimal(
          wirePlan.amountOutMinimumAtomic,
          "Minimum output amount",
        ),
        deadline: uint256Decimal(wirePlan.deadlineUnix, "Deadline"),
        branches: wirePlan.branches.map((branch) => ({
          amountIn: uint256Decimal(branch.amountInAtomic, "Branch input"),
          minAmountOut: uint256Decimal(
            branch.amountOutMinimumAtomic,
            "Branch minimum output",
          ),
          operations: branch.operations.map((operation) => ({
            kind: operation.kind,
            tokenOut: getAddress(operation.tokenOut),
            fee: operation.feePips,
            tickSpacing: operation.tickSpacing,
            poolId: operation.poolId as `0x${string}`,
          })),
        })),
      };
      if (
        plan.minAmountOut === 0n ||
        plan.branches.some(
          (branch) => branch.amountIn === 0n || branch.minAmountOut === 0n,
        ) ||
        plan.branches.reduce((total, branch) => total + branch.amountIn, 0n) !==
          plan.amountIn
      )
        throw new Error("Atomic V1 minimum output must be positive.");

      const acceptedChainId = requiredUint(program.chainId, "chain ID");
      const acceptedTokenIn = requiredBytes(program.tokenIn, 20, "input token");
      const acceptedTokenOut = requiredBytes(
        program.tokenOut,
        20,
        "output token",
      );
      const acceptedAmountIn = requiredUint(program.amountIn, "input amount");
      const decodedBranches = program.branches.map((branch, branchIndex) => ({
        amountIn: requiredUint(branch.amountIn, `branch ${branchIndex} input`),
        minimum: requiredUint(
          accepted.branchMinima[branchIndex],
          `branch ${branchIndex} minimum`,
        ),
        operations: branch.operations.map((operation, operationIndex) => {
          if (
            operation.pool.case !== "uniswapV3" ||
            operation.pool.value.feePips === undefined
          )
            throw new Error("Invalid Atomic V1 accepted provider.");
          const label = `branch ${branchIndex} operation ${operationIndex}`;
          return {
            tokenIn: requiredBytes(
              operation.tokenIn,
              20,
              `${label} input token`,
            ),
            tokenOut: requiredBytes(
              operation.tokenOut,
              20,
              `${label} output token`,
            ),
            factory: requiredBytes(
              operation.pool.value.factory,
              20,
              `${label} factory`,
            ),
            router: requiredBytes(
              operation.pool.value.router,
              20,
              `${label} router`,
            ),
            pool: requiredBytes(operation.pool.value.pool, 20, `${label} pool`),
            fee: operation.pool.value.feePips,
          };
        }),
      }));
      const acceptedExecutorAddress = requiredBytes(
        acceptedExecutor.address,
        20,
        "executor",
      );
      const acceptedRuntimeHash = requiredBytes(
        acceptedExecutor.runtimeCodeHash,
        32,
        "runtime hash",
      );
      const acceptedSigner = requiredBytes(accepted.signer, 20, "signer");
      const acceptedRecipient = requiredBytes(
        accepted.recipient,
        20,
        "recipient",
      );
      const aggregateMinimum = requiredUint(
        accepted.amountOutMinimum,
        "aggregate minimum",
      );
      const quoteBlockNumber = requiredUint(
        quoteBlock.number,
        "quote block number",
      );
      const quoteBlockHash = requiredBytes(
        quoteBlock.hash,
        32,
        "quote block hash",
      );
      const expiresAt = requiredUint(accepted.expiresAtUnix, "expiry");
      const acceptedDeadline = requiredUint(accepted.deadlineUnix, "deadline");
      if (
        acceptedChainId !== BigInt(wirePlan.chainId) ||
        !same(acceptedTokenIn, p.tokenIn) ||
        !same(acceptedTokenOut, p.tokenOut) ||
        acceptedAmountIn !== plan.amountIn ||
        decodedBranches.some(
          (branch, branchIndex) =>
            branch.amountIn !== plan.branches[branchIndex].amountIn ||
            branch.minimum !== plan.branches[branchIndex].minAmountOut ||
            branch.operations.some((operation, operationIndex) => {
              const leg = routes[branchIndex].legs[operationIndex];
              return (
                !same(operation.tokenIn, leg.tokenIn) ||
                !same(operation.tokenOut, leg.tokenOut) ||
                !same(operation.factory, factory) ||
                !same(operation.router, deployment.router) ||
                !same(operation.pool, leg.pool) ||
                operation.fee !== leg.selector.value
              );
            }),
        ) ||
        new Set(
          decodedBranches.flatMap((branch) =>
            branch.operations.map((operation) => operation.pool.toLowerCase()),
          ),
        ).size !== legs.length ||
        !same(acceptedExecutorAddress, address) ||
        !same(acceptedRuntimeHash, runtimeCodeHash) ||
        !same(acceptedSigner, p.recipient) ||
        !same(acceptedRecipient, p.recipient) ||
        aggregateMinimum !== plan.minAmountOut ||
        quoteBlockNumber !== BigInt(block.number) ||
        !same(quoteBlockHash, block.hash) ||
        expiresAt !== BigInt(p.expiresAtUnix) ||
        acceptedDeadline !== plan.deadline
      )
        throw new Error("Atomic V1 accepted terms differ from preparation.");

      const branchHashes = decodedBranches.map((branch) => {
        const operationHashes = branch.operations.map((operation) => {
          const providerHash = keccak256(
            encodeAbiParameters(
              [
                { type: "bytes32" },
                { type: "uint8" },
                { type: "address" },
                { type: "address" },
                { type: "address" },
                { type: "uint24" },
              ],
              [
                domain("Epeius.AtomicProvider.v1"),
                1,
                getAddress(operation.factory),
                getAddress(operation.router),
                getAddress(operation.pool),
                operation.fee,
              ],
            ),
          );
          return keccak256(
            encodeAbiParameters(
              [
                { type: "bytes32" },
                { type: "uint8" },
                { type: "address" },
                { type: "address" },
                { type: "bytes32" },
              ],
              [
                domain("Epeius.AtomicOperation.v1"),
                1,
                getAddress(operation.tokenIn),
                getAddress(operation.tokenOut),
                providerHash,
              ],
            ),
          );
        });
        return keccak256(
          encodeAbiParameters(
            [
              { type: "bytes32" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "bytes32[]" },
            ],
            [
              domain("Epeius.AtomicAcceptedBranch.v1"),
              branch.amountIn,
              branch.minimum,
              operationHashes,
            ],
          ),
        );
      });
      const planId = atomicV1PlanId({
        chainId: acceptedChainId,
        executor: getAddress(acceptedExecutorAddress),
        runtimeCodeHash: acceptedRuntimeHash,
        signer: getAddress(acceptedSigner),
        recipient: getAddress(acceptedRecipient),
        tokenIn: getAddress(acceptedTokenIn),
        tokenOut: getAddress(acceptedTokenOut),
        amountIn: acceptedAmountIn,
        minimum: aggregateMinimum,
        quoteBlockNumber,
        quoteBlockHash,
        expiresAt,
        deadline: acceptedDeadline,
        branchHashes,
      });
      if (!same(planId, bytesToHex(wirePlan.planId)))
        throw new Error("Atomic V1 plan ID does not match accepted terms.");
      if (
        !same(
          atomicV1ExecutorPlanHash({
            chainId: BigInt(wirePlan.chainId),
            executor: address,
            sender: getAddress(wirePlan.sender),
            plan,
          }),
          wirePlan.executorPlanHash,
        )
      )
        throw new Error(
          "Atomic V1 executor plan hash does not match its terms.",
        );
      const data = atomicV1ExecutorCalldata(plan);
      const tx = p.transaction;
      if (
        !tx ||
        !same(
          atomicV1TransactionFingerprint({
            planId,
            chainId: BigInt(tx.chainId),
            from: getAddress(tx.from),
            to: getAddress(tx.to),
            value: BigInt(tx.valueAtomic),
            data: tx.data as `0x${string}`,
            gasLimit: BigInt(tx.gasLimit),
          }),
          bytesToHex(wirePlan.transactionFingerprint),
        )
      )
        throw new Error("Atomic V1 transaction fingerprint does not match.");
      return {
        target: address,
        spender: address,
        data,
        quotedOutput: routes
          .reduce(
            (total, route) =>
              total +
              uint256Decimal(route.amountOutAtomic, "Route quoted output"),
            0n,
          )
          .toString(),
        routeDetails: routes.map(v3Review),
        receipt: {
          atomicPlan: {
            executor: address,
            planHash: wirePlan.executorPlanHash,
            planId,
            transactionFingerprint: bytesToHex(wirePlan.transactionFingerprint),
            branches: routes.map((route, i) => ({
              amountInAtomic: wirePlan.branches[i].amountInAtomic,
              minimumAtomic: wirePlan.branches[i].amountOutMinimumAtomic,
              operations: route.legs.map((leg) => ({
                kind: 1,
                tokenIn: leg.tokenIn,
                tokenOut: leg.tokenOut,
              })),
            })),
          },
          intermediate: routes
            .flatMap((route) => route.legs.slice(0, -1))
            .map((leg) => ({
              token: leg.tokenOut,
              owner: deployment.router,
            })),
          touched: [
            { token: p.tokenIn, owner: address },
            ...routes
              .flatMap((route) => route.legs.slice(0, -1))
              .map((leg) => ({ token: leg.tokenOut, owner: address })),
            { token: p.tokenOut, owner: address },
            { token: p.tokenIn, owner: deployment.router },
            ...routes
              .flatMap((route) => route.legs.slice(0, -1))
              .map((leg) => ({
                token: leg.tokenOut,
                owner: deployment.router,
              })),
            { token: p.tokenOut, owner: deployment.router },
          ],
        },
      };
    },
  };
}
