import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Hex,
  isAddress,
} from "viem";

export type Receipt = {
  transactionHash: string;
  status: string;
  blockHash?: string | null;
  blockNumber?: string | null;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    removed?: boolean;
  }>;
};

export type ReceiptObligations = {
  tokenIn: string;
  tokenOut: string;
  recipient: string;
  amountInAtomic: string;
  amountOutMinimumAtomic: string;
  intermediate: Array<{ token: string; owner: string }>;
  touched?: Array<{ token: string; owner: string }>;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const transfer = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0];

export function verifyReceipt(
  receipt: Receipt,
  hash: string,
  obligations: ReceiptObligations,
) {
  if (!same(receipt.transactionHash, hash))
    return {
      outcome: "unavailable",
      reason: "Receipt transaction hash mismatch.",
    };
  if (receipt.status !== "0x1")
    return {
      outcome: "failed",
      reason: "Transaction reverted or receipt status is not successful.",
    };
  try {
    const deltas = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (!same(log.transactionHash, hash) || log.removed)
        throw new Error("Invalid receipt log identity.");
      if (!same(log.topics[0] ?? "", transfer)) continue;
      if (!isAddress(log.address, { strict: false }))
        throw new Error("Nonstandard Transfer log.");
      const { args } = decodeEventLog({
        abi: erc20Abi,
        eventName: "Transfer",
        strict: true,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      const topics = encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: args.from, to: args.to },
      });
      const data = encodeAbiParameters([{ type: "uint256" }], [args.value]);
      if (
        topics.length !== log.topics.length ||
        topics.some((topic, i) => !same(String(topic), log.topics[i])) ||
        !same(data, log.data)
      )
        throw new Error("Nonstandard Transfer log.");
      for (const [owner, sign] of [
        [args.from, -1n],
        [args.to, 1n],
      ] as const) {
        const key = `${log.address.toLowerCase()}:${owner.toLowerCase()}`;
        deltas.set(key, (deltas.get(key) ?? 0n) + sign * args.value);
      }
    }
    const delta = (token: string, owner: string) =>
      deltas.get(`${token.toLowerCase()}:${owner.toLowerCase()}`) ?? 0n;
    const input = -delta(obligations.tokenIn, obligations.recipient);
    const output = delta(obligations.tokenOut, obligations.recipient);
    const intermediate = Object.fromEntries(
      obligations.intermediate.map(({ token, owner }) => [
        token,
        delta(token, owner).toString(),
      ]),
    );
    const touched = Object.fromEntries(
      (obligations.touched ?? []).map(({ token, owner }) => [
        `${token}:${owner}`,
        delta(token, owner).toString(),
      ]),
    );
    const residue = [
      ...obligations.intermediate,
      ...(obligations.touched ?? []),
    ].some(({ token, owner }) => delta(token, owner) !== 0n);
    return {
      outcome:
        input === BigInt(obligations.amountInAtomic) &&
        output >= BigInt(obligations.amountOutMinimumAtomic) &&
        !residue
          ? "passed"
          : "failed",
      inputSpentAtomic: input.toString(),
      outputReceivedAtomic: output.toString(),
      routerIntermediateDeltas: intermediate,
      ...(obligations.touched ? { touchedTokenOwnerDeltas: touched } : {}),
      reason:
        "Exact-transaction standard ERC20 Transfer net deltas; no pre-existing balances counted.",
    };
  } catch {
    return {
      outcome: "unavailable",
      reason: "Receipt cannot establish standard ERC20 transfer invariants.",
    };
  }
}
