import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { concatHex, fromRlp, keccak256, toRlp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { UnsignedTransactionSchema } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  admitSignedAtomicEnvelope,
  atomicEnvelope,
} from "./atomic-signed-envelope";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const other = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const transaction = create(UnsignedTransactionSchema, {
  chainId: "8453",
  from: account.address,
  to: "0x0000000000000000000000000000000000000044",
  valueAtomic: "7",
  data: "0x661983c5",
  gasLimit: "1000000",
});
const envelope = atomicEnvelope(9n, 30n, 2n);

const sign = (
  changes: Partial<{
    account: typeof account;
    type: "eip1559" | "legacy";
    chainId: number;
    nonce: number;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    gas: bigint;
    to: `0x${string}`;
    value: bigint;
    data: `0x${string}`;
    accessList: Array<{
      address: `0x${string}`;
      storageKeys: `0x${string}`[];
    }>;
  }> = {},
) =>
  (changes.account ?? account).signTransaction(
    changes.type === "legacy"
      ? {
          type: "legacy",
          chainId: changes.chainId ?? 8453,
          nonce: changes.nonce ?? 9,
          gasPrice: 30n,
          gas: changes.gas ?? 1_000_000n,
          to: changes.to ?? (transaction.to as `0x${string}`),
          value: changes.value ?? 7n,
          data: changes.data ?? (transaction.data as `0x${string}`),
        }
      : {
          type: "eip1559",
          chainId: changes.chainId ?? 8453,
          nonce: changes.nonce ?? 9,
          maxFeePerGas: changes.maxFeePerGas ?? 30n,
          maxPriorityFeePerGas: changes.maxPriorityFeePerGas ?? 2n,
          gas: changes.gas ?? 1_000_000n,
          to: changes.to ?? (transaction.to as `0x${string}`),
          value: changes.value ?? 7n,
          data: changes.data ?? (transaction.data as `0x${string}`),
          accessList: changes.accessList ?? [],
        },
  );

test("signed Atomic type-2 envelope independently decodes, recovers, and hashes", async () => {
  const raw = await sign();
  const decoded = await admitSignedAtomicEnvelope(raw, transaction, envelope);
  expect(decoded).toMatchObject({
    type: 2,
    chainId: "8453",
    nonce: "9",
    signer: account.address,
    to: transaction.to,
    valueAtomic: "7",
    data: "0x661983c5",
    gasLimit: "1000000",
    maxFeePerGasAtomic: "30",
    maxPriorityFeePerGasAtomic: "2",
    accessList: [],
    rawTransaction: raw,
    transactionHash: keccak256(raw),
  });
  expect(decoded.r).toMatch(/^0x[0-9a-f]{64}$/);
  expect(decoded.s).toMatch(/^0x[0-9a-f]{64}$/);
});

test("signed Atomic admission rejects every changed authority field", async () => {
  const changed = [
    await sign({ type: "legacy" }),
    await sign({ chainId: 8454 }),
    await sign({ nonce: 10 }),
    await sign({ maxFeePerGas: 31n }),
    await sign({ maxPriorityFeePerGas: 3n }),
    await sign({ gas: 1_000_001n }),
    await sign({ to: "0x0000000000000000000000000000000000000045" }),
    await sign({ value: 8n }),
    await sign({ data: "0x661983c6" }),
    await sign({ account: other }),
    await sign({
      accessList: [
        {
          address: transaction.to as `0x${string}`,
          storageKeys: [],
        },
      ],
    }),
  ];
  for (const raw of changed)
    await expect(
      admitSignedAtomicEnvelope(raw, transaction, envelope),
    ).rejects.toThrow();
});

test("signed Atomic admission rejects malformed signatures and noncanonical integers", async () => {
  const raw = await sign();
  await expect(
    admitSignedAtomicEnvelope("0x02", transaction, envelope),
  ).rejects.toThrow();
  await expect(
    admitSignedAtomicEnvelope(`${raw.slice(0, -2)}00`, transaction, envelope),
  ).rejects.toThrow();

  const decoded = fromRlp(`0x${raw.slice(4)}`) as unknown[];
  decoded[1] = "0x0009";
  const noncanonical = concatHex([
    "0x02",
    toRlp(decoded as Parameters<typeof toRlp>[0]),
  ]);
  await expect(
    admitSignedAtomicEnvelope(noncanonical, transaction, envelope),
  ).rejects.toThrow("noncanonical");
});

test("Atomic nonce and fee admission is exact and bounded", () => {
  expect(atomicEnvelope(0n, 1n, 0n)).toEqual({
    type: 2,
    nonce: "0",
    maxFeePerGasAtomic: "1",
    maxPriorityFeePerGasAtomic: "0",
    accessList: [],
  });
  expect(() => atomicEnvelope(-1n, 1n, 0n)).toThrow();
  expect(() => atomicEnvelope(1n << 64n, 1n, 0n)).toThrow();
  expect(() => atomicEnvelope(0n, 0n, 0n)).toThrow();
  expect(() => atomicEnvelope(0n, 1n, -1n)).toThrow();
  expect(() => atomicEnvelope(0n, 1n, 2n)).toThrow();
  expect(() => atomicEnvelope(0n, 1n << 256n, 0n)).toThrow();
});
