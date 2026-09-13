package uniswapv4

import (
	"bytes"
	"context"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

type callFake func(context.Context, common.Address, []byte, common.Hash) ([]byte, error)

func (f callFake) Call(ctx context.Context, to common.Address, data []byte, block common.Hash) ([]byte, error) {
	return f(ctx, to, data, block)
}

func word(value *big.Int) []byte {
	result := make([]byte, 32)
	value.FillBytes(result)
	return result
}

func TestPoolIDAndPinnedQuoteCalldata(t *testing.T) {
	weth := common.HexToAddress("0x4200000000000000000000000000000000000006")
	usdc := common.HexToAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
	key := NewPoolKey(weth, usdc, 500, 10, common.Address{})
	id, err := PoolID(key)
	if err != nil || id.Hex() != "0x90333bb05c258fe0dddb2840ef66f1a05165aa7dac6815d24e807cc6ebd943a0" {
		t.Fatalf("pool ID = %s, error = %v", id, err)
	}
	block := common.HexToHash("0xf67b26827b23b4dc03e3e682832f35fc492929afd96aff61fa382e8d638a8ded")
	quoter := common.HexToAddress("0x0d5e0f971ed27fbff6c2837bf31316121532048d")
	want := common.FromHex("0xaa9d21cb00000000000000000000000000000000000000000000000000000000000000200000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000")
	client := callFake(func(_ context.Context, to common.Address, data []byte, gotBlock common.Hash) ([]byte, error) {
		if to != quoter || gotBlock != block || !bytes.Equal(data, want) {
			t.Fatalf("unexpected pinned call: to=%s block=%s data=%x", to, gotBlock, data)
		}
		return append(word(big.NewInt(2035547039)), word(big.NewInt(196076))...), nil
	})
	output, err := (Provider{Client: client, Quoter: quoter}).Quote(context.Background(), key, true, big.NewInt(1_000_000_000_000_000_000), block)
	if err != nil || output.String() != "2035547039" {
		t.Fatalf("output = %v, error = %v", output, err)
	}
}

func TestQuoteRejectsAmountsOutsideUint128(t *testing.T) {
	called := false
	provider := Provider{Client: callFake(func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
		called = true
		return nil, nil
	})}
	for _, amount := range []*big.Int{nil, new(big.Int), new(big.Int).Lsh(big.NewInt(1), 128)} {
		if _, err := provider.Quote(context.Background(), PoolKey{}, true, amount, common.Hash{}); err == nil {
			t.Fatal("invalid amount accepted")
		}
	}
	if called {
		t.Fatal("invalid amount reached RPC")
	}
	if !bytes.Equal(crypto.Keccak256([]byte("quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))"))[:4], common.FromHex("0xaa9d21cb")) {
		t.Fatal("reviewed quoter selector changed")
	}
}
