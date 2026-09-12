package quote

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

func TestSlipstreamQuotesTwoHopsSequentially(t *testing.T) {
	factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
	quoter := common.HexToAddress("0x2222222222222222222222222222222222222222")
	module := common.HexToAddress("0x3333333333333333333333333333333333333333")
	firstPool := common.HexToAddress("0x4444444444444444444444444444444444444444")
	secondPool := common.HexToAddress("0x5555555555555555555555555555555555555555")
	tokens := []common.Address{common.HexToAddress(tokenA), common.HexToAddress(tokenB), common.HexToAddress(tokenC)}
	poolCall := 0
	quoteCall := 0
	reader := readerFake{call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
		if hash != common.HexToHash(blockHash) {
			t.Fatal("call was not pinned")
		}
		signature := func(value string) bool { return bytes.Equal(data[:4], crypto.Keccak256([]byte(value))[:4]) }
		if to == factory && signature("swapFeeModule()") {
			return poolResponse(module), nil
		}
		if to == module && signature("discounted(address)") {
			if common.BytesToAddress(data[4:36]) != (common.Address{}) {
				t.Fatal("quote-origin check used wrong account")
			}
			return uintWord(0), nil
		}
		if to == factory {
			if common.BytesToAddress(data[4:36]) != tokens[poolCall] || common.BytesToAddress(data[36:68]) != tokens[poolCall+1] {
				t.Fatalf("pool lookup %d used wrong token pair", poolCall+1)
			}
			if new(big.Int).SetBytes(data[68:100]).Int64() != 100 {
				t.Fatal("spacing changed in pool lookup")
			}
			poolCall++
			if poolCall == 1 {
				return poolResponse(firstPool), nil
			}
			return poolResponse(secondPool), nil
		}
		if to != quoter {
			return nil, errors.New("wrong quoter")
		}
		quoteCall++
		amount := new(big.Int).SetBytes(data[68:100]).Uint64()
		if quoteCall == 1 && amount != 17 || quoteCall == 2 && amount != 31 {
			t.Fatalf("hop %d input = %d", quoteCall, amount)
		}
		if quoteCall == 1 {
			return quoteResponse(31), nil
		}
		return quoteResponse(47), nil
	}}
	q := slipstreamQuoter{reader: reader, deployment: config.Deployment{Kind: "aerodrome-slipstream", Factory: factory.Hex(), Quoter: quoter.Hex()}}
	legs, output, err := q.quote(context.Background(), tokens, []int32{100, 100}, big.NewInt(17), common.HexToHash(blockHash))
	if err != nil || output.Uint64() != 47 || poolCall != 2 || len(legs) != 2 ||
		legs[0].TokenIn != tokenA || legs[0].TokenOut != tokenB || legs[0].Pool != firstPool.Hex() || legs[0].GetTickSpacing() != 100 || legs[0].GetFeePips() != 0 ||
		legs[1].TokenIn != tokenB || legs[1].TokenOut != tokenC || legs[1].Pool != secondPool.Hex() || legs[1].GetTickSpacing() != 100 || legs[1].GetFeePips() != 0 {
		t.Fatalf("legs=%+v output=%v err=%v", legs, output, err)
	}
}

func TestSlipstreamRouterCalldataUsesSignedPathAndExactTuple(t *testing.T) {
	route := &quotev1.RouteQuote{Legs: []*quotev1.RouteLeg{
		{TokenIn: tokenA, TokenOut: tokenB, Selector: &quotev1.RouteLeg_TickSpacing{TickSpacing: -1}},
		{TokenIn: tokenB, TokenOut: tokenC, Selector: &quotev1.RouteLeg_TickSpacing{TickSpacing: 100}},
	}}
	data, err := slipstreamRouterData(route, wallet, big.NewInt(17), big.NewInt(11), 123)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data[:4], crypto.Keccak256([]byte("exactInput((bytes,address,uint256,uint256,uint256))"))[:4]) {
		t.Fatal("wrong exactInput selector")
	}
	tuple := data[36:]
	if common.BytesToAddress(tuple[32:64]) != common.HexToAddress(wallet) || new(big.Int).SetBytes(tuple[64:96]).Uint64() != 123 || new(big.Int).SetBytes(tuple[96:128]).Uint64() != 17 || new(big.Int).SetBytes(tuple[128:160]).Uint64() != 11 {
		t.Fatal("router terms changed")
	}
	offset := new(big.Int).SetBytes(tuple[:32]).Int64()
	length := new(big.Int).SetBytes(tuple[offset : offset+32]).Int64()
	expected := append(common.HexToAddress(tokenA).Bytes(), 0xff, 0xff, 0xff)
	expected = append(expected, common.HexToAddress(tokenB).Bytes()...)
	expected = append(expected, 0, 0, 100)
	expected = append(expected, common.HexToAddress(tokenC).Bytes()...)
	if !bytes.Equal(tuple[offset+32:offset+32+length], expected) {
		t.Fatalf("path=%x", tuple[offset+32:offset+32+length])
	}
	for _, spacing := range []int32{slipstream.MinTickSpacing - 1, slipstream.MaxTickSpacing + 1} {
		route.Legs[0].Selector = &quotev1.RouteLeg_TickSpacing{TickSpacing: spacing}
		if _, err := slipstreamPath(route); err == nil {
			t.Fatalf("accepted spacing %d", spacing)
		}
	}
}

func TestSlipstreamQuoteRejectsDiscountedCallOrigin(t *testing.T) {
	factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
	quoter := common.HexToAddress("0x2222222222222222222222222222222222222222")
	module := common.HexToAddress("0x3333333333333333333333333333333333333333")
	pool := common.HexToAddress("0x4444444444444444444444444444444444444444")
	hash := common.HexToHash(blockHash)
	discountCalls := 0
	reader := readerFake{call: func(_ context.Context, target common.Address, data []byte, gotHash common.Hash) ([]byte, error) {
		if gotHash != hash {
			t.Fatal("quote-origin check was not pinned")
		}
		signature := func(value string) bool { return bytes.Equal(data[:4], crypto.Keccak256([]byte(value))[:4]) }
		switch {
		case target == factory && signature("swapFeeModule()"):
			return poolResponse(module), nil
		case target == module && signature("discounted(address)"):
			discountCalls++
			if common.BytesToAddress(data[4:36]) != (common.Address{}) {
				t.Fatal("discount lookup did not use the quote-call origin")
			}
			return uintWord(1), nil
		case target == factory && signature("getPool(address,address,int24)"):
			return poolResponse(pool), nil
		case target == quoter:
			return quoteResponse(47), nil
		default:
			return nil, errors.New("unexpected call")
		}
	}}
	q := slipstreamQuoter{
		reader:     reader,
		id:         "slip",
		deployment: config.Deployment{Kind: "aerodrome-slipstream", Factory: factory.Hex(), Quoter: quoter.Hex()},
		options:    slipstream.Options{TickSpacings: []int32{100}},
	}
	next := q.Candidates(
		&quotev1.QuoteRequest{TokenIn: tokenA, TokenOut: tokenB, AmountInAtomic: "17"},
		&quotev1.BlockContext{Hash: blockHash},
	)
	candidate, ok := next(context.Background())
	if !ok {
		t.Fatal("missing candidate")
	}
	route, err := candidate.Quote(context.Background())
	if err == nil || route != nil || discountCalls != 1 {
		t.Fatalf("route=%+v discountCalls=%d error=%v", route, discountCalls, err)
	}
}

func TestSlipstreamChecksQuoteOriginOncePerSearch(t *testing.T) {
	factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
	quoter := common.HexToAddress("0x2222222222222222222222222222222222222222")
	module := common.HexToAddress("0x3333333333333333333333333333333333333333")
	pool := common.HexToAddress("0x4444444444444444444444444444444444444444")
	moduleChecks := 0
	originChecks := 0
	reader := readerFake{call: func(_ context.Context, target common.Address, data []byte, _ common.Hash) ([]byte, error) {
		signature := func(value string) bool { return bytes.Equal(data[:4], crypto.Keccak256([]byte(value))[:4]) }
		switch {
		case target == factory && signature("swapFeeModule()"):
			moduleChecks++
			return poolResponse(module), nil
		case target == module && signature("discounted(address)"):
			originChecks++
			return uintWord(0), nil
		case target == factory && signature("getPool(address,address,int24)"):
			return poolResponse(pool), nil
		case target == quoter:
			return quoteResponse(47), nil
		default:
			return nil, errors.New("unexpected call")
		}
	}}
	q := slipstreamQuoter{
		reader:     reader,
		id:         "slip",
		deployment: config.Deployment{Kind: "aerodrome-slipstream", Factory: factory.Hex(), Quoter: quoter.Hex()},
		options:    slipstream.Options{TickSpacings: []int32{100, 200}},
	}
	next := q.Candidates(
		&quotev1.QuoteRequest{TokenIn: tokenA, TokenOut: tokenB, AmountInAtomic: "17"},
		&quotev1.BlockContext{Hash: blockHash},
	)
	quoted := 0
	for {
		candidate, ok := next(context.Background())
		if !ok {
			break
		}
		if _, err := candidate.Quote(context.Background()); err != nil {
			t.Fatal(err)
		}
		quoted++
	}
	if quoted != 2 || moduleChecks != 1 || originChecks != 1 {
		t.Fatalf("quoted=%d moduleChecks=%d originChecks=%d", quoted, moduleChecks, originChecks)
	}
}

func TestSlipstreamDiscountCheckHandlesModuleCapabilitiesAndRejectsDiscount(t *testing.T) {
	factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
	module := common.HexToAddress("0x2222222222222222222222222222222222222222")
	hash := common.HexToHash(blockHash)
	// The portable fee-module interface does not include discounted(address),
	// so canonical static modules revert this optional capability probe.
	// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/interfaces/fees/IFeeModule.sol#L6-L15
	for _, test := range []struct {
		name        string
		discount    uint64
		wrongLink   bool
		missingCode bool
		static      bool
		rpcFailure  bool
		want        string
	}{
		{name: "undiscounted"},
		{name: "discounted", discount: 1, want: "Signer has a Slipstream tx.origin fee discount"},
		{name: "static fee module", static: true},
		{name: "discount lookup failure", rpcFailure: true, want: "Slipstream fee discount check failed"},
		{name: "wrong module factory", wrongLink: true, want: "Slipstream fee discount check failed"},
		{name: "missing module code", missingCode: true, want: "Slipstream fee discount check failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := codeFake{code: func(_ context.Context, target common.Address, gotHash common.Hash) ([]byte, error) {
				if target != module || gotHash != hash || test.missingCode {
					return nil, nil
				}
				return []byte{1}, nil
			}, readerFake: readerFake{call: func(_ context.Context, target common.Address, data []byte, gotHash common.Hash) ([]byte, error) {
				if gotHash != hash {
					t.Fatal("discount check was not pinned")
				}
				signature := func(value string) bool { return bytes.Equal(data[:4], crypto.Keccak256([]byte(value))[:4]) }
				switch {
				case target == factory && signature("swapFeeModule()"):
					return poolResponse(module), nil
				case target == module && signature("factory()"):
					if test.wrongLink {
						return poolResponse(common.HexToAddress(tokenC)), nil
					}
					return poolResponse(factory), nil
				case target == module && signature("discounted(address)"):
					if common.BytesToAddress(data[4:36]) != common.HexToAddress(wallet) {
						t.Fatal("discount lookup used wrong signer")
					}
					if test.static {
						return nil, rpc.ErrEmptyExecutionRevert
					}
					if test.rpcFailure {
						return nil, errors.New("rpc unavailable")
					}
					return uintWord(test.discount), nil
				default:
					return nil, errors.New("unexpected call")
				}
			}}}
			got := verifySlipstreamSignerDiscount(context.Background(), reader, hash, factory, wallet)
			if got != test.want {
				t.Fatalf("message=%q", got)
			}
		})
	}
}
