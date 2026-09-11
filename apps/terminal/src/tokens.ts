import { isAddress, maxUint256, parseUnits } from "viem";
import type {
  ChainStatus,
  Token,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type { LocalChainConfig } from "./config";

function normalizedAddress(value: string): string {
  const prefixed = `0x${value.replace(/^0x/i, "")}`;
  return isAddress(prefixed, { strict: false }) ? prefixed.toLowerCase() : "";
}

export function trustChainTokens(
  chain: ChainStatus,
  local: LocalChainConfig | undefined,
): ChainStatus {
  if (!local)
    throw new Error(`Chain ${chain.key} is missing from local config.`);
  const trusted = chain.tokens.map((remote) => {
    const address = normalizedAddress(remote.address);
    const configured = local.tokens.find(
      (token) => normalizedAddress(token.address) === address,
    );
    if (
      !address ||
      !configured ||
      configured.symbol !== remote.symbol ||
      configured.decimals !== remote.decimals
    )
      throw new Error(
        `Engine token metadata for ${remote.symbol || remote.address} does not match local config.`,
      );
    return {
      ...remote,
      symbol: configured.symbol,
      decimals: configured.decimals,
    };
  });
  if (trusted.length !== local.tokens.length)
    throw new Error(
      `Engine token metadata for chain ${chain.key} does not match local config.`,
    );
  return { ...chain, tokens: trusted };
}

export function resolveToken(value: string, tokens: Token[]): Token {
  const matches = isAddress(value, { strict: false })
    ? tokens.filter(
        (token) => token.address.toLowerCase() === value.toLowerCase(),
      )
    : tokens.filter(
        (token) => token.symbol.toLowerCase() === value.toLowerCase(),
      );
  if (matches.length === 0)
    throw new Error(`Token ${value} is not supported on this chain.`);
  if (matches.length > 1)
    throw new Error(`Token symbol ${value} is ambiguous; use an address.`);
  return matches[0];
}

export function parseAtomic(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > maxUint256)
    throw new Error("Use a positive uint256 integer for --amount-atomic.");
  return value;
}

export function decimalToAtomic(value: string, decimals: number): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))
    throw new Error("Use a positive decimal amount for --amount.");
  const [, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Amount has more than ${decimals} decimal places.`);
  if (decimals === 0 && fraction)
    throw new Error("Amount has more than 0 decimal places.");
  const atomic = parseUnits(value, decimals);
  if (atomic <= 0n || atomic > maxUint256)
    throw new Error("Amount must be a positive uint256 value.");
  return atomic.toString();
}

export function chainFromStatus(
  chains: ChainStatus[],
  key: string,
): ChainStatus {
  const chain = chains.find((item) => item.key === key);
  if (!chain) throw new Error(`Chain ${key} is not supported by engine.`);
  return chain;
}
