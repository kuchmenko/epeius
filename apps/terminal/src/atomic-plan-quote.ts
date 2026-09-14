import {
  type Address,
  bytesToHex,
  encodeAbiParameters,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  zeroAddress,
} from "viem";
import type {
  PlanCandidate,
  PlanQuoteResponse,
  PoolOperation,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import type {
  ChainStatus,
  Token,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { formatAtomic } from "./format";

const domain = (value: string) => keccak256(stringToHex(value));
const uint256 = (value: bigint) =>
  hexToBytes(padHex(toHex(value), { size: 32 }));
const addressBytes = (value: string) => hexToBytes(getAddress(value));
const exact = (value: Uint8Array | undefined, size: number, label: string) => {
  if (!value || value.length !== size)
    throw new Error(`Atomic V1 ${label} has the wrong width.`);
  return bytesToHex(value);
};
const requiredAddress = (value: Uint8Array | undefined, label: string) => {
  const address = getAddress(exact(value, 20, label));
  if (address === zeroAddress)
    throw new Error(`Atomic V1 ${label} must not be zero.`);
  return address;
};
const positive = (value: Uint8Array | undefined, label: string) => {
  const number = BigInt(exact(value, 32, label));
  if (number <= 0n) throw new Error(`Atomic V1 ${label} must be positive.`);
  return number;
};
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  !!a && bytesToHex(a) === bytesToHex(b);

function rejectUnknown(value: unknown) {
  if (!value || typeof value !== "object" || value instanceof Uint8Array)
    return;
  const message = value as { $unknown?: unknown[] };
  if (message.$unknown?.length)
    throw new Error("Atomic V1 quote contains unsupported fields.");
  for (const child of Object.values(value)) rejectUnknown(child);
}

const atomicPool = (operation: PoolOperation) => {
  if (operation.pool.case === "uniswapV3")
    return {
      pool: operation.pool.value,
      kind: 1 as const,
      name: "Uniswap V3",
      selector: operation.pool.value.feePips,
      selectorType: "uint24" as const,
    };
  if (operation.pool.case === "pancakeV3")
    return {
      pool: operation.pool.value,
      kind: 2 as const,
      name: "Pancake V3",
      selector: operation.pool.value.feePips,
      selectorType: "uint24" as const,
    };
  if (operation.pool.case === "slipstreamInitial")
    return {
      pool: operation.pool.value,
      kind: 3 as const,
      name: "Aerodrome Slipstream Initial",
      selector: operation.pool.value.tickSpacing,
      selectorType: "int24" as const,
    };
  if (operation.pool.case === "balancerV2")
    return {
      pool: operation.pool.value,
      kind: 4 as const,
      name: "Balancer V2",
      poolId: exact(operation.pool.value.poolId, 32, "Balancer pool ID"),
    };
  throw new Error("Atomic V1 quote uses an unsupported operation.");
};

export function atomicCandidateId(candidate: PlanCandidate) {
  const program = candidate.program;
  const block = candidate.quoteBlock;
  if (!program || !block) throw new Error("Atomic V1 candidate is incomplete.");
  const branchHashes: Hex[] = [];
  const quoteHashes: Hex[] = [];
  if (candidate.branchQuotes.length !== program.branches.length)
    throw new Error("Atomic V1 branch quote cardinality is invalid.");
  for (const [branchIndex, branch] of program.branches.entries()) {
    const operationHashes: Hex[] = [];
    const quote = candidate.branchQuotes[branchIndex];
    if (!quote || quote.operationOutputs.length !== branch.operations.length)
      throw new Error("Atomic V1 operation output cardinality is invalid.");
    for (const operation of branch.operations) {
      const identity = atomicPool(operation);
      const { pool, kind } = identity;
      const selector = kind === 4 ? undefined : identity.selector;
      if (kind !== 4) {
        if (
          selector === undefined ||
          (kind === 3
            ? selector <= 0 || selector > 8_388_607
            : selector < 0 || selector >= 1_000_000)
        )
          throw new Error("Atomic V1 quote has an invalid pool selector.");
      }
      const provider =
        kind === 4
          ? keccak256(
              encodeAbiParameters(
                [
                  { type: "bytes32" },
                  { type: "uint8" },
                  { type: "address" },
                  { type: "bytes32" },
                ],
                [
                  domain("Epeius.AtomicProvider.v1"),
                  4,
                  requiredAddress(pool.vault, "Balancer Vault"),
                  identity.poolId,
                ],
              ),
            )
          : keccak256(
              encodeAbiParameters(
                [
                  { type: "bytes32" },
                  { type: "uint8" },
                  { type: "address" },
                  { type: "address" },
                  { type: "address" },
                  { type: identity.selectorType },
                ],
                [
                  domain("Epeius.AtomicProvider.v1"),
                  kind,
                  requiredAddress(pool.factory, "factory"),
                  requiredAddress(pool.router, "router"),
                  requiredAddress(pool.pool, "pool"),
                  selector ?? 0,
                ],
              ),
            );
      operationHashes.push(
        keccak256(
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
              requiredAddress(operation.tokenIn, "operation input"),
              requiredAddress(operation.tokenOut, "operation output"),
              provider,
            ],
          ),
        ),
      );
    }
    branchHashes.push(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32[]" }],
          [
            domain("Epeius.AtomicProgramBranch.v1"),
            positive(branch.amountIn, "branch input"),
            operationHashes,
          ],
        ),
      ),
    );
    quoteHashes.push(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256[]" }],
          [
            domain("Epeius.AtomicCandidateBranch.v1"),
            quote.operationOutputs.map((output) =>
              positive(output, "operation output"),
            ),
          ],
        ),
      ),
    );
  }
  const programHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32[]" },
      ],
      [
        domain("Epeius.AtomicProgram.v1"),
        1,
        positive(program.chainId, "chain ID"),
        requiredAddress(program.tokenIn, "program input"),
        requiredAddress(program.tokenOut, "program output"),
        positive(program.amountIn, "program input amount"),
        branchHashes,
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32[]" },
      ],
      [
        domain("Epeius.AtomicCandidate.v1"),
        programHash,
        BigInt(exact(block.number, 32, "quote block number")),
        exact(block.hash, 32, "quote block hash"),
        quoteHashes,
      ],
    ),
  );
}

export type AtomicQuoteRequest = {
  chainId: bigint;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
};

export function atomicPlanQuoteRequest(
  request: AtomicQuoteRequest,
  searchBudgetMs: number,
) {
  return {
    formatVersion: 1,
    chainId: uint256(request.chainId),
    tokenIn: addressBytes(request.tokenIn),
    tokenOut: addressBytes(request.tokenOut),
    amountIn: uint256(request.amountIn),
    searchBudgetMs,
  };
}

export function validateAtomicPlanQuote(
  response: PlanQuoteResponse,
  request: AtomicQuoteRequest,
) {
  rejectUnknown(response);
  exact(response.quoteId, 32, "quote ID");
  if (response.searchComplete === undefined)
    throw new Error("Atomic V1 search completion is absent.");
  let previousKey = "";
  let previousProvider = "";
  const seenProviders = new Set<string>();
  for (const candidate of response.candidates) {
    if (candidate.networkCostOut !== undefined)
      throw new Error("Atomic V1 network cost is unsupported.");
    const program = candidate.program;
    if (
      program?.formatVersion !== 1 ||
      !same(program.chainId, uint256(request.chainId)) ||
      !same(program.tokenIn, addressBytes(request.tokenIn)) ||
      !same(program.tokenOut, addressBytes(request.tokenOut)) ||
      !same(program.amountIn, uint256(request.amountIn)) ||
      program.branches.length !== 1 ||
      !same(program.branches[0]?.amountIn, uint256(request.amountIn))
    )
      throw new Error(
        "Atomic V1 candidate program does not match the request.",
      );
    const operations = program.branches[0].operations;
    if (
      operations.length < 1 ||
      operations.length > 2 ||
      (operations[0]?.pool.case === "balancerV2" && operations.length !== 1)
    )
      throw new Error("Atomic V1 candidate path length is unsupported.");
    let current = addressBytes(request.tokenIn);
    const pools = new Set<string>();
    const physicalPools = new Set<string>();
    let factory = "";
    let router = "";
    let providerKind = 0;
    for (const operation of operations) {
      if (!same(operation.tokenIn, current) || !operation.tokenOut)
        throw new Error("Atomic V1 candidate token continuity is invalid.");
      const identity = atomicPool(operation);
      const { pool, kind } = identity;
      const poolAddress =
        kind === 4 ? identity.poolId : requiredAddress(pool.pool, "pool");
      const nextFactory =
        kind === 4 ? "" : requiredAddress(pool.factory, "factory");
      const nextRouter =
        kind === 4
          ? requiredAddress(pool.vault, "Balancer Vault")
          : requiredAddress(pool.router, "router");
      if (
        (!factory && !router && providerKind === 0) ||
        (factory === nextFactory &&
          router === nextRouter &&
          providerKind === kind)
      ) {
        factory = nextFactory;
        router = nextRouter;
        providerKind = kind;
      } else throw new Error("Atomic V1 candidate mixes deployments.");
      const input = exact(operation.tokenIn, 20, "operation input");
      const output = exact(operation.tokenOut, 20, "operation output");
      if (input === output)
        throw new Error("Atomic V1 operation tokens must be distinct.");
      const pair = input < output ? `${input}:${output}` : `${output}:${input}`;
      const physical =
        kind === 4
          ? `4:${identity.poolId}`
          : `${kind}:${pair}:${identity.selector}`;
      if (pools.has(poolAddress) || physicalPools.has(physical))
        throw new Error("Atomic V1 candidate reuses a pool.");
      pools.add(poolAddress);
      physicalPools.add(physical);
      current = operation.tokenOut;
    }
    if (!same(current, addressBytes(request.tokenOut)))
      throw new Error("Atomic V1 candidate final token is invalid.");
    const selectors = operations.map((operation) => {
      const identity = atomicPool(operation);
      return identity.kind === 4
        ? identity.poolId
        : String(identity.selector).padStart(9, "0");
    });
    const middle =
      operations.length === 2
        ? getAddress(exact(operations[0].tokenOut, 20, "intermediate token"))
        : "";
    const key = `${operations.length - 1}:${middle}:${selectors.join(":")}`;
    const provider = `${providerKind}:${factory}:${router}`;
    if (provider !== previousProvider) {
      if (seenProviders.has(provider))
        throw new Error("Atomic V1 provider candidate groups are reordered.");
      seenProviders.add(provider);
      previousProvider = provider;
      previousKey = "";
    }
    if (key <= previousKey)
      throw new Error("Atomic V1 candidates are not in canonical order.");
    previousKey = key;
    const expected = atomicCandidateId(candidate);
    if (exact(candidate.candidateId, 32, "candidate ID") !== expected)
      throw new Error("Atomic V1 candidate ID does not match its contents.");
  }
  return response;
}

export function formatAtomicPlanQuote(
  response: PlanQuoteResponse,
  chain: Pick<ChainStatus, "key" | "chainId" | "tokens">,
  tokenIn: Token,
  tokenOut: Token,
  amountIn: bigint,
) {
  const amount = (token: Token, value: bigint) =>
    `${formatAtomic(value.toString(), token.decimals)} ${token.symbol} (${value} atomic)`;
  const token = (address: string) =>
    chain.tokens.find(
      (item) => item.address.toLowerCase() === address.toLowerCase(),
    );
  const lines = [
    `Atomic V1 quote ${exact(response.quoteId, 32, "quote ID")} — ${chain.key} (${chain.chainId})`,
    `Search complete: ${String(response.searchComplete)}`,
    `Input: ${amount(tokenIn, amountIn)}`,
  ];
  if (!response.searchComplete)
    lines.push("WARNING: Search was partial; some candidates may be missing.");
  for (const [candidateIndex, candidate] of response.candidates.entries()) {
    const operations = candidate.program?.branches[0]?.operations ?? [];
    const outputs = candidate.branchQuotes[0]?.operationOutputs ?? [];
    lines.push(
      "",
      `Candidate ${candidateIndex + 1}: ${exact(candidate.candidateId, 32, "candidate ID")}`,
      `Quote block: ${BigInt(exact(candidate.quoteBlock?.number, 32, "quote block number"))} (${exact(candidate.quoteBlock?.hash, 32, "quote block hash")})`,
    );
    for (const [hopIndex, operation] of operations.entries()) {
      const outputAddress = exact(operation.tokenOut, 20, "operation output");
      const metadata = token(outputAddress);
      const output = BigInt(exact(outputs[hopIndex], 32, "operation output"));
      const identity = atomicPool(operation);
      const { pool, name, kind } = identity;
      lines.push(
        kind === 4
          ? `Hop ${hopIndex + 1} (${name}, kind 4): ${exact(operation.tokenIn, 20, "operation input")} to ${outputAddress}; pool ID ${identity.poolId}; Vault ${requiredAddress(pool.vault, "Balancer Vault")}; output ${metadata ? amount(metadata, output) : `${output} atomic`}`
          : `Hop ${hopIndex + 1} (${name}): ${exact(operation.tokenIn, 20, "operation input")} to ${outputAddress}; pool ${exact(pool.pool, 20, "pool")}; ${kind === 3 ? `tick spacing ${identity.selector}` : `fee ${identity.selector} pips`}; output ${metadata ? amount(metadata, output) : `${output} atomic`}`,
      );
    }
    const final = BigInt(exact(outputs.at(-1), 32, "final output"));
    lines.push(`Aggregate/final output: ${amount(tokenOut, final)}`);
  }
  if (!response.candidates.length) lines.push("No candidates returned.");
  lines.push(
    "Candidates are ordered crossings, not a best or net-output recommendation.",
  );
  return lines.join("\n");
}
