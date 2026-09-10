// Package uniswapv3 quotes configured Uniswap and Pancake V3 deployments.
package uniswapv3

import (
	"bytes"
	"context"
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

type Caller interface {
	Call(context.Context, common.Address, []byte, common.Hash) ([]byte, error)
}

type Provider struct {
	Client         Caller
	FactoryAddress common.Address
	QuoterAddress  common.Address
}

type singleInput struct {
	TokenIn           common.Address
	TokenOut          common.Address
	AmountIn          *big.Int
	Fee               *big.Int
	SqrtPriceLimitX96 *big.Int
}

// Quote returns a zero pool and nil amount when no pool exists for this fee.
func (p Provider) Quote(ctx context.Context, in, out common.Address, amount *big.Int, fee uint32, block common.Hash) (common.Address, *big.Int, error) {
	data, err := factoryABI.Pack("getPool", in, out, new(big.Int).SetUint64(uint64(fee)))
	if err != nil {
		return common.Address{}, nil, err
	}
	result, err := p.Client.Call(ctx, p.FactoryAddress, data, block)
	if err != nil {
		return common.Address{}, nil, errors.New("pool discovery failed at the pinned block")
	}
	values, err := factoryABI.Unpack("getPool", result)
	if err != nil {
		return common.Address{}, nil, errors.New("invalid factory response")
	}
	pool := values[0].(common.Address)
	if pool == (common.Address{}) {
		return pool, nil, nil
	}
	data, err = quoterABI.Pack("quoteExactInputSingle", singleInput{in, out, amount, new(big.Int).SetUint64(uint64(fee)), new(big.Int)})
	if err != nil {
		return pool, nil, err
	}
	result, err = p.Client.Call(ctx, p.QuoterAddress, data, block)
	if err != nil {
		return pool, nil, errors.New("quote failed at the pinned block")
	}
	values, err = quoterABI.Unpack("quoteExactInputSingle", result)
	if err != nil {
		return pool, nil, errors.New("invalid quoter response")
	}
	output := values[0].(*big.Int)
	if output.Sign() <= 0 {
		return pool, nil, errors.New("quote returned zero output")
	}
	// QuoterV2 replaces a zero limit with TickMath.MAX_SQRT_RATIO - 1
	// or MIN_SQRT_RATIO + 1. Reaching it can leave input unconsumed.
	limit := "1461446703485210103287273052203988822378723970341"
	if bytes.Compare(in[:], out[:]) < 0 {
		limit = "4295128740"
	}
	if values[1].(*big.Int).String() == limit {
		return pool, nil, errors.New("quote reached the price limit; full input consumption is not guaranteed")
	}
	// Quoter gasEstimate is not a network cost estimate. No gas pricing,
	// economic scoring, or best-route recommendation is produced here.
	return pool, output, nil
}
