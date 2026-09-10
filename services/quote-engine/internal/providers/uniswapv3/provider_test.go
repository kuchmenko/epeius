package uniswapv3

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// These tests use mocked contract responses only: no forks or synthetic liquidity.
type callFake func(context.Context, common.Address, []byte, common.Hash) ([]byte, error)

func (f callFake) Call(ctx context.Context, to common.Address, data []byte, block common.Hash) ([]byte, error) {
	return f(ctx, to, data, block)
}

func selector(signature string) []byte { return crypto.Keccak256([]byte(signature))[:4] }

func word(value *big.Int) []byte {
	b := make([]byte, 32)
	value.FillBytes(b)
	return b
}

func addressWord(value common.Address) []byte {
	b := make([]byte, 32)
	copy(b[12:], value[:])
	return b
}

func TestQuoteCalldataDirectionsAmountBeforeFeeAndPinnedBlock(t *testing.T) {
	pool := common.HexToAddress("0x1111111111111111111111111111111111111111")
	block := common.HexToHash("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	amount := new(big.Int).Lsh(big.NewInt(1), 200)
	amount.Add(amount, big.NewInt(987654321))
	for _, test := range []struct {
		name    string
		in, out common.Address
		fee     uint32
		output  int64
	}{
		{"WETH to USDC", WETH, USDC, 500, 71234567},
		{"USDC to WETH", USDC, WETH, 3000, 9988776655},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			fake := callFake(func(_ context.Context, to common.Address, data []byte, gotBlock common.Hash) ([]byte, error) {
				calls++
				if gotBlock != block {
					t.Fatalf("block = %s, want %s", gotBlock, block)
				}
				switch calls {
				case 1:
					if to != Factory || !bytes.Equal(data[:4], selector("getPool(address,address,uint24)")) {
						t.Fatalf("factory call to=%s data=%x", to, data)
					}
					if len(data) != 100 || common.BytesToAddress(data[16:36]) != test.in || common.BytesToAddress(data[48:68]) != test.out || new(big.Int).SetBytes(data[68:100]).Uint64() != uint64(test.fee) {
						t.Fatalf("factory calldata = %x", data)
					}
					return addressWord(pool), nil
				case 2:
					if to != Quoter || !bytes.Equal(data[:4], selector("quoteExactInputSingle((address,address,uint256,uint24,uint160))")) {
						t.Fatalf("quoter call to=%s data=%x", to, data)
					}
					if len(data) != 164 {
						t.Fatalf("quoter calldata length = %d", len(data))
					}
					// Decode tuple words directly. In particular, amountIn is word 3 and fee is word 4.
					if common.BytesToAddress(data[16:36]) != test.in || common.BytesToAddress(data[48:68]) != test.out || new(big.Int).SetBytes(data[68:100]).Cmp(amount) != 0 || new(big.Int).SetBytes(data[100:132]).Uint64() != uint64(test.fee) || new(big.Int).SetBytes(data[132:164]).Sign() != 0 {
						t.Fatalf("quoter tuple calldata = %x", data)
					}
					return bytes.Join([][]byte{word(big.NewInt(test.output)), word(big.NewInt(23)), word(big.NewInt(7)), word(big.NewInt(456789))}, nil), nil
				default:
					t.Fatalf("unexpected call %d", calls)
					return nil, nil
				}
			})
			gotPool, gotOutput, err := (Provider{Client: fake}).Quote(context.Background(), test.in, test.out, amount, test.fee, block)
			if err != nil || gotPool != pool || gotOutput.Cmp(big.NewInt(test.output)) != 0 || calls != 2 {
				t.Fatalf("Quote = (%s, %v, %v), calls=%d", gotPool, gotOutput, err, calls)
			}
		})
	}
}

func TestQuoteResponsesAndFailures(t *testing.T) {
	pool := common.HexToAddress("0x2222222222222222222222222222222222222222")
	validPool := addressWord(pool)
	validQuote := bytes.Join([][]byte{word(big.NewInt(9)), word(big.NewInt(1)), word(big.NewInt(2)), word(big.NewInt(3))}, nil)
	tests := []struct {
		name       string
		factory    []byte
		factoryErr error
		quote      []byte
		quoteErr   error
		wantPool   common.Address
		wantAmount *big.Int
		wantErr    string
		wantCalls  int
	}{
		{"missing pool", make([]byte, 32), nil, nil, nil, common.Address{}, nil, "", 1},
		{"factory call error", nil, errors.New("secret upstream detail"), nil, nil, common.Address{}, nil, "pool discovery failed at the pinned block", 1},
		{"malformed factory response", []byte{1}, nil, nil, nil, common.Address{}, nil, "invalid factory response", 1},
		{"quote call error", validPool, nil, nil, errors.New("secret upstream detail"), pool, nil, "quote failed at the pinned block", 2},
		{"malformed quote response", validPool, nil, []byte{1}, nil, pool, nil, "invalid quoter response", 2},
		{"zero output", validPool, nil, make([]byte, 128), nil, pool, nil, "quote returned zero output", 2},
		{"valid output", validPool, nil, validQuote, nil, pool, big.NewInt(9), "", 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			fake := callFake(func(_ context.Context, _ common.Address, _ []byte, _ common.Hash) ([]byte, error) {
				calls++
				if calls == 1 {
					return test.factory, test.factoryErr
				}
				return test.quote, test.quoteErr
			})
			gotPool, gotAmount, err := (Provider{Client: fake}).Quote(context.Background(), WETH, USDC, big.NewInt(123), 100, common.Hash{})
			if gotPool != test.wantPool || calls != test.wantCalls {
				t.Fatalf("pool=%s calls=%d", gotPool, calls)
			}
			if (err == nil) != (test.wantErr == "") || err != nil && err.Error() != test.wantErr {
				t.Fatalf("error = %v, want %q", err, test.wantErr)
			}
			if test.wantAmount == nil && gotAmount != nil || test.wantAmount != nil && (gotAmount == nil || gotAmount.Cmp(test.wantAmount) != 0) {
				t.Fatalf("amount = %v", gotAmount)
			}
		})
	}
}

func TestQuoteRejectsDirectionalPriceLimit(t *testing.T) {
	pool := common.HexToAddress("0x2222222222222222222222222222222222222222")
	for _, tc := range []struct {
		name    string
		in, out common.Address
		price   string
		reject  bool
	}{
		{"lower limit", WETH, USDC, "4295128740", true},
		{"above lower limit", WETH, USDC, "4295128741", false},
		{"upper limit", USDC, WETH, "1461446703485210103287273052203988822378723970341", true},
		{"below upper limit", USDC, WETH, "1461446703485210103287273052203988822378723970340", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			price, ok := new(big.Int).SetString(tc.price, 10)
			if !ok {
				t.Fatal("invalid test price")
			}
			fake := callFake(func(_ context.Context, to common.Address, _ []byte, _ common.Hash) ([]byte, error) {
				if to == Factory {
					return addressWord(pool), nil
				}
				return bytes.Join([][]byte{word(big.NewInt(71234567)), word(price), word(big.NewInt(7)), word(big.NewInt(456789))}, nil), nil
			})
			gotPool, output, err := (Provider{Client: fake}).Quote(context.Background(), tc.in, tc.out, big.NewInt(123456789), 10000, common.Hash{})
			if gotPool != pool {
				t.Fatal("lost pool identity")
			}
			if tc.reject {
				if err == nil || err.Error() != "quote reached the price limit; full input consumption is not guaranteed" || output != nil {
					t.Fatalf("price-limit quote accepted: output=%v error=%v", output, err)
				}
			} else if err != nil || output == nil || output.String() != "71234567" {
				t.Fatalf("near-limit quote changed: output=%v error=%v", output, err)
			}
		})
	}
}
