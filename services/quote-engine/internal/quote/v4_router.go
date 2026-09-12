package quote

import (
	"context"
	"errors"
	"math/big"
	"strconv"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
)

const permit2PermissionLifetime = 30 * 60

type v4RouterPreparation struct {
	id, chainID     string
	router, permit2 string
	admit           func(*quotev1.RouteQuote) (uniswapv4.Pool, bool)
}

func (s v4RouterPreparation) Select(_ context.Context, _ storedQuote, _ *quotev1.PrepareExecutionRequest, route *quotev1.RouteQuote) (executionSelection, string) {
	if _, ok := s.admit(route); !ok {
		return executionSelection{}, "unsupported Uniswap V4 route"
	}
	output, _ := new(big.Int).SetString(route.AmountOutAtomic, 10)
	return executionSelection{route: route, output: output}, ""
}

func (s v4RouterPreparation) Build(p *quotev1.PrepareExecutionResponse) (executionPlan, string) {
	pool, ok := s.admit(p.Route)
	if !ok {
		return executionPlan{}, "unsupported Uniswap V4 route"
	}
	amount, _ := new(big.Int).SetString(p.AmountInAtomic, 10)
	minimum, _ := new(big.Int).SetString(p.AmountOutMinimumAtomic, 10)
	if amount.BitLen() > 128 || minimum.Sign() <= 0 || minimum.BitLen() > 128 {
		return executionPlan{}, "Uniswap V4 amounts must fit uint128"
	}
	deadline, _ := strconv.ParseUint(p.DeadlineUnix, 10, 64)
	data, err := uniswapV4RouterData(pool, p.Route.Legs[0].TokenIn, amount, minimum, deadline)
	if err != nil {
		return executionPlan{}, "unsupported Uniswap V4 route"
	}
	tx := &quotev1.UnsignedTransaction{ChainId: s.chainID, To: common.HexToAddress(s.router).Hex(), From: p.Recipient, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "1500000"}
	checks := directChecks(p.Route, tx)
	checks.Preserve = append(checks.Preserve,
		BalanceProbe{p.TokenIn, tx.To},
		BalanceProbe{p.TokenOut, tx.To},
	)
	return executionPlan{
		transaction: tx,
		spender:     common.HexToAddress(s.permit2).Hex(),
		permission: &permissionPlan{
			target: common.HexToAddress(s.permit2).Hex(), token: p.TokenIn,
			spender: tx.To, amount: amount, expiration: deadline + permit2PermissionLifetime,
		},
		checks: checks,
	}, ""
}

var v4SwapArguments = abi.Arguments{{Type: mustABIType("bytes", nil)}, {Type: mustABIType("bytes[]", nil)}}
var settleArguments = abi.Arguments{{Type: mustABIType("address", nil)}, {Type: mustABIType("uint256", nil)}, {Type: mustABIType("bool", nil)}}
var takeAllArguments = abi.Arguments{{Type: mustABIType("address", nil)}, {Type: mustABIType("uint256", nil)}}

// Base Universal Router 2.0.0 uses this deployed-generation tuple. Newer
// V4Router source adds minHopPriceX36 and is not byte-compatible.
var exactInputSingleArguments = abi.Arguments{{Type: mustABIType("tuple", []abi.ArgumentMarshaling{
	{Name: "poolKey", Type: "tuple", Components: []abi.ArgumentMarshaling{
		{Name: "currency0", Type: "address"}, {Name: "currency1", Type: "address"}, {Name: "fee", Type: "uint24"}, {Name: "tickSpacing", Type: "int24"}, {Name: "hooks", Type: "address"},
	}},
	{Name: "zeroForOne", Type: "bool"}, {Name: "amountIn", Type: "uint128"}, {Name: "amountOutMinimum", Type: "uint128"}, {Name: "hookData", Type: "bytes"},
})}}

func mustABIType(name string, components []abi.ArgumentMarshaling) abi.Type {
	typeOf, err := abi.NewType(name, "", components)
	if err != nil {
		panic(err)
	}
	return typeOf
}

func uniswapV4RouterData(pool uniswapv4.Pool, tokenIn string, amount, minimum *big.Int, deadline uint64) ([]byte, error) {
	key := v4PoolKey(pool)
	type exactInputSingle struct {
		PoolKey          uniswapv4.PoolKey
		ZeroForOne       bool
		AmountIn         *big.Int
		AmountOutMinimum *big.Int
		HookData         []byte
	}
	swap, err := exactInputSingleArguments.Pack(exactInputSingle{key, common.HexToAddress(tokenIn) == key.Currency0, amount, minimum, []byte{}})
	if err != nil {
		return nil, err
	}
	settle, err := settleArguments.Pack(common.HexToAddress(tokenIn), amount, true)
	if err != nil {
		return nil, err
	}
	output := key.Currency0
	if common.HexToAddress(tokenIn) == key.Currency0 {
		output = key.Currency1
	}
	take, err := takeAllArguments.Pack(output, minimum)
	if err != nil {
		return nil, err
	}
	input, err := v4SwapArguments.Pack([]byte{0x06, 0x0b, 0x0f}, [][]byte{swap, settle, take})
	if err != nil {
		return nil, err
	}
	data, err := contractabi.UniswapUniversalRouter.Pack("execute", []byte{0x10}, [][]byte{input}, new(big.Int).SetUint64(deadline))
	if err != nil {
		return nil, errors.New("could not encode Universal Router call")
	}
	return data, nil
}
