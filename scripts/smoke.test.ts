import { test } from "bun:test";
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import {
  type QuoteFinal,
  QuoteFinalSchema,
} from "../generated/ts/epeius/quote/v1/quote_pb";
import { assertQuote, parseScenario } from "./smoke";

const tokenA = `0x${"1".repeat(40)}`;
const tokenB = `0x${"2".repeat(40)}`;
const tokenC = `0x${"3".repeat(40)}`;
const block = { number: "42", hash: `0x${"a".repeat(64)}` };

function quote() {
  return create(QuoteFinalSchema, {
    block,
    bestRouteId: "two-hop",
    routes: [
      {
        routeId: "direct",
        amountOutAtomic: "99",
        block,
        legs: [{ tokenIn: tokenA, tokenOut: tokenC }],
      },
      {
        routeId: "two-hop",
        amountOutAtomic: "101",
        block,
        legs: [
          { tokenIn: tokenA, tokenOut: tokenB },
          { tokenIn: tokenB, tokenOut: tokenC },
        ],
      },
      {
        routeId: "later-tie",
        amountOutAtomic: "101",
        block,
        legs: [{ tokenIn: tokenA, tokenOut: tokenC }],
      },
    ],
  });
}

test("smoke requires one explicit pair and amount without default token assumptions", () => {
  const args = [
    "--chain",
    "fixture-chain",
    "--in",
    "A",
    "--out",
    "C",
    "--amount",
    "1.25",
  ];
  assert.deepEqual(parseScenario([...args, "--config", "fixture.toml"]), {
    chain: "fixture-chain",
    tokenIn: "A",
    tokenOut: "C",
    amount: "1.25",
    config: "fixture.toml",
  });
  assert.throws(() => parseScenario([]), /requires/);
  assert.throws(() => parseScenario(args.slice(0, -2)), /requires/);
  assert.throws(() => parseScenario([...args, "--broadcast"]));
  for (const amount of ["0", "0.00", "-1", "1e3", "NaN"])
    assert.throws(
      () => parseScenario([...args.slice(0, -2), `--amount=${amount}`]),
      /positive decimal/,
    );
  assert.throws(
    () =>
      parseScenario([
        "--chain",
        "base",
        "--in",
        "A",
        "--out",
        "A",
        "--amount",
        "1",
      ]),
    /differ/,
  );
});

test("smoke accepts connected direct and two-hop routes and first maximum recommendation", () => {
  const result = quote();
  const before = structuredClone(result);
  assertQuote(result, tokenA, tokenC);
  assert.deepEqual(
    result,
    before,
    "smoke must not reorder or substitute quote data",
  );
  result.routes = [result.routes[0]];
  result.bestRouteId = "direct";
  assertQuote(result, tokenA, tokenC);
});

for (const [name, mutate] of [
  [
    "missing recommendation",
    (q) => {
      q.bestRouteId = undefined;
    },
  ],
  [
    "lower output recommendation",
    (q) => {
      q.bestRouteId = "direct";
    },
  ],
  [
    "later equal output recommendation",
    (q) => {
      q.bestRouteId = "later-tie";
    },
  ],
  [
    "disconnected intermediate",
    (q) => {
      q.routes[1].legs[1].tokenIn = tokenA;
    },
  ],
  [
    "wrong input",
    (q) => {
      q.routes[0].legs[0].tokenIn = tokenB;
    },
  ],
  [
    "wrong output",
    (q) => {
      q.routes[1].legs[1].tokenOut = tokenB;
    },
  ],
  [
    "three hops",
    (q) => {
      q.routes[1].legs.push(q.routes[1].legs[1]);
    },
  ],
  [
    "zero hops",
    (q) => {
      q.routes[0].legs = [];
    },
  ],
  [
    "different block",
    (q) => {
      assert.ok(q.block);
      q.routes[0].block = { ...q.block, number: "43" };
    },
  ],
  [
    "missing block",
    (q) => {
      q.routes[0].block = undefined;
    },
  ],
  [
    "no routes",
    (q) => {
      q.routes = [];
    },
  ],
  [
    "zero output",
    (q) => {
      q.routes[0].amountOutAtomic = "0";
    },
  ],
] satisfies Array<[string, (quote: QuoteFinal) => void]>) {
  test(`smoke rejects ${name}`, () => {
    const result = quote();
    mutate(result);
    assert.throws(() => assertQuote(result, tokenA, tokenC));
  });
}
