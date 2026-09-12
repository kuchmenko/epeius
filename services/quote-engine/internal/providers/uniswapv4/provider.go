// Package uniswapv4 quotes allowlisted single-pool Uniswap V4 routes.
package uniswapv4

import (
	"context"
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
)

type Caller interface {
	Call(context.Context, common.Address, []byte, common.Hash) ([]byte, error)
}

type PoolKey struct {
	Currency0   common.Address
	Currency1   common.Address
	Fee         *big.Int
	TickSpacing *big.Int
	Hooks       common.Address
}

type quoteExactSingleParams struct {
	PoolKey     PoolKey
	ZeroForOne  bool
	ExactAmount *big.Int
	HookData    []byte
}

type Provider struct {
	Client    Caller
	Quoter    common.Address
	StateView common.Address
}

var poolKeyType = mustPoolKeyType()

func mustPoolKeyType() abi.Type {
	typeOf, err := abi.NewType("tuple", "PoolKey", []abi.ArgumentMarshaling{
		{Name: "currency0", Type: "address"},
		{Name: "currency1", Type: "address"},
		{Name: "fee", Type: "uint24"},
		{Name: "tickSpacing", Type: "int24"},
		{Name: "hooks", Type: "address"},
	})
	if err != nil {
		panic(err)
	}
	return typeOf
}

func NewPoolKey(currency0, currency1 common.Address, fee uint32, tickSpacing int32, hooks common.Address) PoolKey {
	return PoolKey{currency0, currency1, new(big.Int).SetUint64(uint64(fee)), big.NewInt(int64(tickSpacing)), hooks}
}

func PoolID(key PoolKey) (common.Hash, error) {
	encoded, err := (abi.Arguments{{Type: poolKeyType}}).Pack(key)
	if err != nil {
		return common.Hash{}, err
	}
	return crypto.Keccak256Hash(encoded), nil
}

func (p Provider) Quote(ctx context.Context, key PoolKey, zeroForOne bool, amount *big.Int, block common.Hash) (*big.Int, error) {
	if amount == nil || amount.Sign() <= 0 || amount.BitLen() > 128 {
		return nil, errors.New("Uniswap V4 input must fit uint128")
	}
	data, err := contractabi.UniswapV4Quoter.Pack("quoteExactInputSingle", quoteExactSingleParams{key, zeroForOne, amount, []byte{}})
	if err != nil {
		return nil, err
	}
	result, err := p.Client.Call(ctx, p.Quoter, data, block)
	if err != nil {
		return nil, errors.New("Uniswap V4 quote failed at the pinned block")
	}
	values, err := evm.Unpack(contractabi.UniswapV4Quoter.Methods["quoteExactInputSingle"], result)
	if err != nil {
		return nil, errors.New("invalid Uniswap V4 quoter response")
	}
	output := values[0].(*big.Int)
	if output.Sign() <= 0 {
		return nil, errors.New("Uniswap V4 quote returned zero output")
	}
	return output, nil
}

func (p Provider) VerifyPool(ctx context.Context, key PoolKey, block common.Hash) error {
	id, err := PoolID(key)
	if err != nil {
		return err
	}
	data, err := contractabi.UniswapV4StateView.Pack("getSlot0", id)
	if err != nil {
		return err
	}
	result, err := p.Client.Call(ctx, p.StateView, data, block)
	if err != nil {
		return errors.New("Uniswap V4 pool state unavailable")
	}
	values, err := evm.Unpack(contractabi.UniswapV4StateView.Methods["getSlot0"], result)
	if err != nil || values[0].(*big.Int).Sign() == 0 {
		return errors.New("Uniswap V4 pool is not initialized")
	}
	return nil
}
