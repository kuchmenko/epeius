import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Independent word-layout encoder; cast supplies only Keccak and a cross-check.
const signature =
  "execute(address,address,uint256,uint256,uint256,(uint8,uint256,(address,uint24)[])[])";
const selector = execFileSync("cast", ["sig", signature], {
  encoding: "utf8",
}).trim();
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";
const c = "0x3333333333333333333333333333333333333333";
const vectors = [
  {
    name: "single-uniswap",
    tokenIn: a,
    tokenOut: c,
    amountIn: "101",
    minAmountOut: "199",
    deadline: "2000000000",
    allocations: [
      { venue: 0, amountIn: "101", hops: [{ tokenOut: c, fee: 500 }] },
    ],
  },
  {
    name: "pancake-two-hop",
    tokenIn: a,
    tokenOut: c,
    amountIn: "123456789",
    minAmountOut: "987654",
    deadline: "2000000001",
    allocations: [
      {
        venue: 1,
        amountIn: "123456789",
        hops: [
          { tokenOut: b, fee: 0 },
          { tokenOut: c, fee: 2500 },
        ],
      },
    ],
  },
  {
    name: "split-37-64",
    tokenIn: a,
    tokenOut: c,
    amountIn: "101",
    minAmountOut: "199",
    deadline: "2000000002",
    allocations: [
      { venue: 0, amountIn: "37", hops: [{ tokenOut: c, fee: 3000 }] },
      {
        venue: 1,
        amountIn: "64",
        hops: [
          { tokenOut: b, fee: 0 },
          { tokenOut: c, fee: 10000 },
        ],
      },
    ],
  },
];
for (const vector of vectors) {
  const bodies = vector.allocations.map((allocation) =>
    [
      allocation.venue,
      allocation.amountIn,
      96,
      allocation.hops.length,
      ...allocation.hops.flatMap((hop) => [hop.tokenOut, hop.fee]),
    ]
      .map(word)
      .join(""),
  );
  let offset = bodies.length * 32;
  const offsets = bodies.map((body) => {
    const current = word(offset);
    offset += body.length / 2;
    return current;
  });
  const args = [
    vector.tokenIn,
    vector.tokenOut,
    vector.amountIn,
    vector.minAmountOut,
    vector.deadline,
  ];
  vector.calldata =
    selector +
    [...args, 192, bodies.length].map(word).join("") +
    offsets.join("") +
    bodies.join("");
  const tuples = `[${vector.allocations.map((allocation) => `(${allocation.venue},${allocation.amountIn},[${allocation.hops.map((hop) => `(${hop.tokenOut},${hop.fee})`).join(",")}])`).join(",")}]`;
  const cast = execFileSync("cast", ["calldata", signature, ...args, tuples], {
    encoding: "utf8",
  }).trim();
  if (cast !== vector.calldata)
    throw new Error(`ABI cross-check failed: ${vector.name}`);
}
writeFileSync(
  new URL("executor-calldata.json", import.meta.url),
  `${JSON.stringify({ signature, selector, vectors }, null, 2)}\n`,
);
