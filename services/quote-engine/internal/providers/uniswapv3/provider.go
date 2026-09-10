// Package uniswapv3 quotes direct Base mainnet pools only. Aerodrome,
// intermediate-token routes, and split routing are outside this implementation.
package uniswapv3

import (
	"context"
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

var (
	Factory = common.HexToAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD")
	Quoter  = common.HexToAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a")
	WETH    = common.HexToAddress("0x4200000000000000000000000000000000000006")
	USDC    = common.HexToAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
)

type Caller interface {
	Call(context.Context, common.Address, []byte, common.Hash) ([]byte, error)
}

type Provider struct{ Client Caller }

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
	result, err := p.Client.Call(ctx, Factory, data, block)
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
	result, err = p.Client.Call(ctx, Quoter, data, block)
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
	// Quoter gasEstimate is not a network cost estimate. No gas pricing,
	// economic scoring, or best-route recommendation is produced here.
	return pool, output, nil
}
