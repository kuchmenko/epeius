// Package slipstream quotes Aerodrome Slipstream pools.
package slipstream

import (
	"bytes"
	"context"
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
)

const (
	maxQuoteInputBitLength = 255
	// TickMath defines these as the exclusive swap limits plus or minus one.
	// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/libraries/TickMath.sol#L8-L16
	minimumUsableSqrtPriceX96 = "4295128740"
	maximumUsableSqrtPriceX96 = "1461446703485210103287273052203988822378723970341"
)

type Caller interface {
	Call(context.Context, common.Address, []byte, common.Hash) ([]byte, error)
}

type Provider struct {
	Client                        Caller
	FactoryAddress, QuoterAddress common.Address
}

type singleInput struct {
	TokenIn, TokenOut common.Address
	AmountIn          *big.Int
	TickSpacing       *big.Int
	SqrtPriceLimitX96 *big.Int
}

func (p Provider) Quote(ctx context.Context, in, out common.Address, amount *big.Int, spacing int32, block common.Hash) (common.Address, *big.Int, error) {
	// QuoterV2 converts exact-input uint256 to positive int256 before calling the pool.
	// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/lens/QuoterV2.sol#L105-L125
	if amount.Sign() <= 0 || amount.BitLen() > maxQuoteInputBitLength {
		return common.Address{}, nil, errors.New("quote input exceeds Slipstream signed amount limit")
	}
	data, err := contractabi.AerodromeSlipstreamFactory.Pack("getPool", in, out, big.NewInt(int64(spacing)))
	if err != nil {
		return common.Address{}, nil, err
	}
	result, err := p.Client.Call(ctx, p.FactoryAddress, data, block)
	if err != nil {
		return common.Address{}, nil, errors.New("pool discovery failed at the pinned block")
	}
	values, err := evm.Unpack(contractabi.AerodromeSlipstreamFactory.Methods["getPool"], result)
	if err != nil {
		return common.Address{}, nil, errors.New("invalid factory response")
	}
	pool := values[0].(common.Address)
	if pool == (common.Address{}) {
		return pool, nil, nil
	}
	data, err = contractabi.AerodromeSlipstreamQuoterV2.Pack("quoteExactInputSingle", singleInput{in, out, amount, big.NewInt(int64(spacing)), new(big.Int)})
	if err != nil {
		return pool, nil, err
	}
	result, err = p.Client.Call(ctx, p.QuoterAddress, data, block)
	if err != nil {
		return pool, nil, errors.New("quote failed at the pinned block")
	}
	values, err = evm.Unpack(contractabi.AerodromeSlipstreamQuoterV2.Methods["quoteExactInputSingle"], result)
	if err != nil || values[1].(*big.Int).BitLen() > 160 {
		return pool, nil, errors.New("invalid quoter response")
	}
	output := values[0].(*big.Int)
	if output.Sign() <= 0 {
		return pool, nil, errors.New("quote returned zero output")
	}
	// A zero requested limit makes QuoterV2 choose TickMath's direction-specific
	// extreme. Reaching it can leave exact input unconsumed because pool swapping
	// stops when either amount is exhausted or price reaches its limit.
	// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/CLPool.sol#L678-L725
	limit := maximumUsableSqrtPriceX96
	if bytes.Compare(in[:], out[:]) < 0 {
		limit = minimumUsableSqrtPriceX96
	}
	if values[1].(*big.Int).String() == limit {
		return pool, nil, errors.New("quote reached the price limit; full input consumption is not guaranteed")
	}
	return pool, output, nil
}
