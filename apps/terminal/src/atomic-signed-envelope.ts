import {
  concatHex,
  fromRlp,
  type Hex,
  hexToBigInt,
  isAddress,
  isHash,
  isHex,
  keccak256,
  padHex,
  recoverTransactionAddress,
  toHex,
  toRlp,
} from "viem";
import type { UnsignedTransaction } from "../../../generated/ts/epeius/quote/v1/quote_pb";

export type AtomicEnvelope = {
  type: 2;
  nonce: string;
  maxFeePerGasAtomic: string;
  maxPriorityFeePerGasAtomic: string;
  accessList: [];
};

export type SignedAtomicEnvelope = AtomicEnvelope & {
  chainId: string;
  signer: string;
  to: string;
  valueAtomic: string;
  data: string;
  gasLimit: string;
  yParity: 0 | 1;
  r: string;
  s: string;
  rawTransaction: string;
  transactionHash: string;
};

export function atomicEnvelope(
  nonce: bigint,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): AtomicEnvelope {
  if (
    nonce < 0n ||
    nonce > 0xffff_ffff_ffff_ffffn ||
    maxFeePerGas <= 0n ||
    maxFeePerGas >
      0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn ||
    maxPriorityFeePerGas < 0n ||
    maxPriorityFeePerGas > maxFeePerGas
  )
    throw new Error("Atomic type-2 nonce or fee caps are invalid.");
  return {
    type: 2,
    nonce: nonce.toString(),
    maxFeePerGasAtomic: maxFeePerGas.toString(),
    maxPriorityFeePerGasAtomic: maxPriorityFeePerGas.toString(),
    accessList: [],
  };
}

export async function admitSignedAtomicEnvelope(
  raw: string,
  transaction: UnsignedTransaction,
  expected: AtomicEnvelope,
): Promise<SignedAtomicEnvelope> {
  if (!/^0x02[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0)
    throw new Error("Cast returned malformed signed transaction bytes.");
  let fields: unknown;
  try {
    fields = fromRlp(`0x${raw.slice(4)}` as Hex);
  } catch {
    throw new Error("Cast returned malformed signed transaction bytes.");
  }
  if (!Array.isArray(fields) || fields.length !== 12)
    throw new Error("Signed transaction is not an exact type-2 envelope.");
  if (fields.some((field, index) => index !== 8 && typeof field !== "string"))
    throw new Error("Signed transaction fields are malformed.");
  if (!Array.isArray(fields[8]) || fields[8].length !== 0)
    throw new Error("Signed transaction access list must be empty.");
  const scalars = fields as [
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    Hex,
    [],
    Hex,
    Hex,
    Hex,
  ];
  for (const index of [0, 1, 2, 3, 4, 6, 9, 10, 11]) {
    const scalar = scalars[index] as Hex;
    if (scalar !== "0x" && scalar.slice(2, 4) === "00")
      throw new Error("Signed transaction integer is noncanonical.");
  }
  if (concatHex(["0x02", toRlp(scalars)]) !== raw)
    throw new Error("Signed transaction bytes are noncanonical.");
  const number = (value: Hex) => (value === "0x" ? 0n : hexToBigInt(value));
  const [chainId, nonce, priority, maxFee, gas, to, value, data] = scalars;
  const yParity = number(scalars[9]);
  const r = number(scalars[10]);
  const s = number(scalars[11]);
  const secp256k1Order =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  if (
    yParity > 1n ||
    r === 0n ||
    r >= secp256k1Order ||
    s === 0n ||
    s > secp256k1Order / 2n ||
    !isHex(to, { strict: true }) ||
    to.length !== 42 ||
    !isAddress(to, { strict: false }) ||
    !isHex(data, { strict: true })
  )
    throw new Error("Signed transaction authority is malformed.");
  let signer: string;
  try {
    signer = await recoverTransactionAddress({
      serializedTransaction: raw as `0x02${string}`,
    });
  } catch {
    throw new Error("Signed transaction signature is invalid.");
  }
  const same = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  if (
    number(chainId).toString() !== transaction.chainId ||
    number(nonce).toString() !== expected.nonce ||
    number(priority).toString() !== expected.maxPriorityFeePerGasAtomic ||
    number(maxFee).toString() !== expected.maxFeePerGasAtomic ||
    number(gas).toString() !== transaction.gasLimit ||
    !same(to, transaction.to) ||
    number(value).toString() !== transaction.valueAtomic ||
    data !== transaction.data.toLowerCase() ||
    !same(signer, transaction.from)
  )
    throw new Error("Signed transaction does not match the admitted envelope.");
  const transactionHash = keccak256(raw as Hex);
  if (!isHash(transactionHash))
    throw new Error("Signed transaction hash is invalid.");
  return {
    ...expected,
    chainId: number(chainId).toString(),
    signer,
    to,
    valueAtomic: number(value).toString(),
    data,
    gasLimit: number(gas).toString(),
    yParity: Number(yParity) as 0 | 1,
    r: padHex(scalars[10], { size: 32 }),
    s: padHex(scalars[11], { size: 32 }),
    rawTransaction: raw,
    transactionHash,
  };
}

export function admitRpcAtomicTransaction(
  value: unknown,
  expected: SignedAtomicEnvelope,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Observed transaction is malformed.");
  const tx = value as Record<string, unknown>;
  const quantity = (name: string) => {
    const raw = tx[name];
    if (
      typeof raw !== "string" ||
      !isHex(raw, { strict: true }) ||
      raw === "0x"
    )
      throw new Error("Observed transaction authority is malformed.");
    const number = BigInt(raw);
    if (toHex(number) !== raw.toLowerCase())
      throw new Error("Observed transaction authority is noncanonical.");
    return number.toString();
  };
  const same = (left: unknown, right: string) =>
    typeof left === "string" && left.toLowerCase() === right.toLowerCase();
  const signatureScalar = (name: "r" | "s") => {
    const raw = tx[name];
    if (typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw))
      return BigInt(raw).toString();
    return quantity(name);
  };
  if (
    !same(tx.hash, expected.transactionHash) ||
    quantity("type") !== "2" ||
    quantity("chainId") !== expected.chainId ||
    quantity("nonce") !== expected.nonce ||
    !same(tx.from, expected.signer) ||
    !isAddress(String(tx.from), { strict: false }) ||
    !same(tx.to, expected.to) ||
    !isAddress(String(tx.to), { strict: false }) ||
    !same(tx.input, expected.data) ||
    quantity("value") !== expected.valueAtomic ||
    quantity("gas") !== expected.gasLimit ||
    quantity("maxFeePerGas") !== expected.maxFeePerGasAtomic ||
    quantity("maxPriorityFeePerGas") !== expected.maxPriorityFeePerGasAtomic ||
    !Array.isArray(tx.accessList) ||
    tx.accessList.length !== 0 ||
    quantity("yParity") !== String(expected.yParity) ||
    signatureScalar("r") !== BigInt(expected.r).toString() ||
    signatureScalar("s") !== BigInt(expected.s).toString()
  )
    throw new Error("Observed transaction differs from stored signed bytes.");
}
