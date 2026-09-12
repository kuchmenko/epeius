package slipstream

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

type callerFunc func(context.Context, common.Address, []byte, common.Hash) ([]byte, error)

func (f callerFunc) Call(ctx context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
	return f(ctx, to, data, hash)
}

func word(value *big.Int) []byte { return common.LeftPadBytes(value.Bytes(), 32) }

func addressWord(value common.Address) []byte { return common.LeftPadBytes(value.Bytes(), 32) }

func quoteWords(output, price *big.Int) []byte {
	return bytes.Join([][]byte{word(output), word(price), word(big.NewInt(7)), word(big.NewInt(12345))}, nil)
}

func TestQuoteUsesSignedSpacingTupleAndPinnedSequentialAmount(t *testing.T) {
	factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
	quoter := common.HexToAddress("0x2222222222222222222222222222222222222222")
	pool := common.HexToAddress("0x3333333333333333333333333333333333333333")
	inputToken := common.HexToAddress("0x4444444444444444444444444444444444444444")
	outputToken := common.HexToAddress("0x5555555555555555555555555555555555555555")
	hash := common.HexToHash("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	amount := big.NewInt(17)
	calls := 0
	p := Provider{FactoryAddress: factory, QuoterAddress: quoter, Client: callerFunc(func(_ context.Context, to common.Address, data []byte, gotHash common.Hash) ([]byte, error) {
		if gotHash != hash {
			t.Fatal("call was not pinned")
		}
		calls++
		if calls == 1 {
			if to != factory || len(data) != 100 || !bytes.Equal(data[:4], crypto.Keccak256([]byte("getPool(address,address,int24)"))[:4]) || !bytes.Equal(data[4:36], addressWord(inputToken)) || !bytes.Equal(data[36:68], addressWord(outputToken)) || !bytes.Equal(data[68:100], bytes.Repeat([]byte{0xff}, 32)) {
				t.Fatalf("wrong signed pool lookup: %x", data)
			}
			return addressWord(pool), nil
		}
		if to != quoter || len(data) != 164 || !bytes.Equal(data[:4], crypto.Keccak256([]byte("quoteExactInputSingle((address,address,uint256,int24,uint160))"))[:4]) || !bytes.Equal(data[4:36], addressWord(inputToken)) || !bytes.Equal(data[36:68], addressWord(outputToken)) || !bytes.Equal(data[68:100], word(amount)) || !bytes.Equal(data[100:132], bytes.Repeat([]byte{0xff}, 32)) || new(big.Int).SetBytes(data[132:164]).Sign() != 0 {
			t.Fatalf("wrong quote tuple: %x", data)
		}
		return quoteWords(big.NewInt(29), big.NewInt(1000)), nil
	})}
	gotPool, output, err := p.Quote(context.Background(), inputToken, outputToken, amount, -1, hash)
	if err != nil || gotPool != pool || output.Cmp(big.NewInt(29)) != 0 || calls != 2 {
		t.Fatalf("pool=%s output=%v calls=%d err=%v", gotPool, output, calls, err)
	}
}

func TestQuoteDistinguishesMissingPoolProviderFailureAndUnsafeQuote(t *testing.T) {
	factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
	quoter := common.HexToAddress("0x2222222222222222222222222222222222222222")
	lowerToken := common.HexToAddress("0x4444444444444444444444444444444444444444")
	higherToken := common.HexToAddress("0x5555555555555555555555555555555555555555")
	for _, test := range []struct {
		name   string
		amount *big.Int
		call   callerFunc
		want   string
	}{
		{"missing pool", big.NewInt(1), func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
			return make([]byte, 32), nil
		}, "missing"},
		{"factory failure", big.NewInt(1), func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
			return nil, errors.New("rpc detail")
		}, "pool discovery failed at the pinned block"},
		{"amount overflow", new(big.Int).Lsh(big.NewInt(1), 255), func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
			t.Fatal("called provider")
			return nil, nil
		}, "quote input exceeds Slipstream signed amount limit"},
		{"price extreme", big.NewInt(1), func(_ context.Context, to common.Address, _ []byte, _ common.Hash) ([]byte, error) {
			if to == factory {
				return addressWord(common.HexToAddress("0x3333333333333333333333333333333333333333")), nil
			}
			price, _ := new(big.Int).SetString(minimumUsableSqrtPriceX96, 10)
			return quoteWords(big.NewInt(2), price), nil
		}, "quote reached the price limit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool, output, err := (Provider{Client: test.call, FactoryAddress: factory, QuoterAddress: quoter}).Quote(context.Background(), lowerToken, higherToken, test.amount, 100, common.Hash{})
			if test.want == "missing" {
				if err != nil || pool != (common.Address{}) || output != nil {
					t.Fatalf("%s %v %v", pool, output, err)
				}
			} else if err == nil || !bytes.Contains([]byte(err.Error()), []byte(test.want)) {
				t.Fatalf("error=%v", err)
			}
		})
	}
	upperLimit := callerFunc(func(_ context.Context, to common.Address, _ []byte, _ common.Hash) ([]byte, error) {
		if to == factory {
			return addressWord(common.HexToAddress("0x3333333333333333333333333333333333333333")), nil
		}
		price, _ := new(big.Int).SetString(maximumUsableSqrtPriceX96, 10)
		return quoteWords(big.NewInt(2), price), nil
	})
	if _, _, err := (Provider{Client: upperLimit, FactoryAddress: factory, QuoterAddress: quoter}).Quote(context.Background(), higherToken, lowerToken, big.NewInt(1), 100, common.Hash{}); err == nil || !bytes.Contains([]byte(err.Error()), []byte("quote reached the price limit")) {
		t.Fatalf("upper-direction limit error=%v", err)
	}
	max := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(1))
	called := false
	_, _, _ = (Provider{Client: callerFunc(func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
		called = true
		return nil, errors.New("stop")
	}), FactoryAddress: factory}).Quote(context.Background(), lowerToken, higherToken, max, 100, common.Hash{})
	if !called {
		t.Fatal("2^255-1 was rejected")
	}
}
