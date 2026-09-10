package quote

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv3"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

// These tests use mocked contract responses only: no forks or synthetic liquidity.
type readerFake struct {
	snapshot func(context.Context) (rpc.Snapshot, error)
	call     func(context.Context, common.Address, []byte, common.Hash) ([]byte, error)
}

func (f readerFake) Snapshot(ctx context.Context) (rpc.Snapshot, error) { return f.snapshot(ctx) }
func (f readerFake) Call(ctx context.Context, to common.Address, data []byte, block common.Hash) ([]byte, error) {
	return f.call(ctx, to, data, block)
}

const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func snapshot() rpc.Snapshot { return rpc.Snapshot{BlockNumber: "19283746", BlockHash: blockHash} }

func validRequest() *quotev1.QuoteRequest {
	return &quotev1.QuoteRequest{
		Chain: "base", ChainId: "8453",
		TokenIn: uniswapv3.WETH.Hex(), TokenOut: uniswapv3.USDC.Hex(),
		AmountInAtomic: "1606938044258990275541962092341162602522202993782793822955697",
		SearchBudgetMs: 500,
	}
}

func uintWord(n uint64) []byte {
	b := make([]byte, 32)
	new(big.Int).SetUint64(n).FillBytes(b)
	return b
}

func poolResponse(pool common.Address) []byte {
	b := make([]byte, 32)
	copy(b[12:], pool[:])
	return b
}

func quoteResponse(amount uint64) []byte {
	return bytes.Join([][]byte{uintWord(amount), uintWord(17), uintWord(2), uintWord(345678)}, nil)
}

func calldataFee(data []byte) uint32 {
	// Factory fee is word 3; Quoter tuple fee is word 4.
	if len(data) == 100 {
		return uint32(new(big.Int).SetBytes(data[68:100]).Uint64())
	}
	return uint32(new(big.Int).SetBytes(data[100:132]).Uint64())
}

func callHandler(ctx context.Context, client Reader, request *quotev1.QuoteRequest) (*quotev1.QuoteFinal, error) {
	response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: client}}}).GetQuote(ctx, connect.NewRequest(request))
	if err != nil {
		return nil, err
	}
	return response.Msg, nil
}

func TestHandlerDeterministicFeeOrderPinnedHashMissingPoolsAndErrors(t *testing.T) {
	pool := common.HexToAddress("0x9999999999999999999999999999999999999999")
	delays := map[uint32]time.Duration{100: 35 * time.Millisecond, 500: 20 * time.Millisecond, 3000: 10 * time.Millisecond}
	var calls atomic.Int32
	client := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(_ context.Context, to common.Address, data []byte, block common.Hash) ([]byte, error) {
			calls.Add(1)
			if block != common.HexToHash(blockHash) {
				t.Errorf("call block = %s", block)
			}
			fee := calldataFee(data)
			if to == uniswapv3.Factory {
				time.Sleep(delays[fee])
				switch fee {
				case 500:
					return nil, errors.New("provider leaked detail")
				case 3000:
					return make([]byte, 32), nil
				default:
					return poolResponse(pool), nil
				}
			}
			return quoteResponse(uint64(fee)*101 + 7), nil
		},
	}
	got, err := callHandler(context.Background(), client, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 6 {
		t.Fatalf("calls = %d, want 6", calls.Load())
	}
	if !got.SearchComplete || got.Block.Number != "19283746" || got.Block.Hash != blockHash {
		t.Fatalf("final metadata = %+v", got)
	}
	if len(got.Routes) != 2 || got.Routes[0].RouteId != "uniswap-v3:100" || got.Routes[1].RouteId != "uniswap-v3:10000" {
		t.Fatalf("routes = %+v", got.Routes)
	}
	if got.Routes[0].AmountOutAtomic != "10107" || got.Routes[1].AmountOutAtomic != "1010007" {
		t.Fatalf("asymmetric outputs = %q, %q", got.Routes[0].AmountOutAtomic, got.Routes[1].AmountOutAtomic)
	}
	if len(got.Errors) != 1 || got.Errors[0].GetRouteId() != "uniswap-v3:500" || got.Errors[0].Message != "pool discovery failed at the pinned block" {
		t.Fatalf("errors = %+v", got.Errors)
	}
	if got.BestRouteId != nil || got.Routes[0].NetworkCostOutAtomic != nil || got.Routes[0].EffectiveOutAtomic != nil {
		t.Fatal("cost, effective output, or best route unexpectedly populated")
	}
}

func TestHandlerPartialBudgetKeepsFinishedRouteAndStopsPending(t *testing.T) {
	pool := common.HexToAddress("0x7777777777777777777777777777777777777777")
	var stopped atomic.Int32
	client := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(ctx context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
			fee := calldataFee(data)
			if fee == 100 {
				if to == uniswapv3.Factory {
					return poolResponse(pool), nil
				}
				return quoteResponse(424242), nil
			}
			<-ctx.Done()
			stopped.Add(1)
			return nil, ctx.Err()
		},
	}
	request := validRequest()
	request.SearchBudgetMs = 25
	got, err := callHandler(context.Background(), client, request)
	if err != nil {
		t.Fatal(err)
	}
	if got.SearchComplete || len(got.Routes) != 1 || got.Routes[0].RouteId != "uniswap-v3:100" || got.Routes[0].AmountOutAtomic != "424242" {
		t.Fatalf("partial result = %+v", got)
	}
	if len(got.Errors) != 3 {
		t.Fatalf("missing budget errors: %v", got.Errors)
	}
	for _, err := range got.Errors {
		if err.Message != "search budget expired" {
			t.Fatal(err)
		}
	}
	if stopped.Load() != 3 {
		t.Fatalf("stopped pending calls = %d, want 3", stopped.Load())
	}
}

func TestHandlerParentCancelAndDeadlineStopAllWorkers(t *testing.T) {
	for _, test := range []struct {
		name     string
		deadline bool
		code     connect.Code
	}{
		{"cancel", false, connect.CodeCanceled}, {"deadline", true, connect.CodeDeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			started := make(chan struct{}, 4)
			var stopped atomic.Int32
			client := readerFake{
				snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
				call: func(ctx context.Context, _ common.Address, _ []byte, _ common.Hash) ([]byte, error) {
					started <- struct{}{}
					<-ctx.Done()
					stopped.Add(1)
					return nil, ctx.Err()
				},
			}
			var ctx context.Context
			var cancel context.CancelFunc
			if test.deadline {
				ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
			} else {
				ctx, cancel = context.WithCancel(context.Background())
			}
			defer cancel()
			if !test.deadline {
				go func() {
					for range 4 {
						<-started
					}
					cancel()
				}()
			}
			_, err := callHandler(ctx, client, validRequest())
			if connect.CodeOf(err) != test.code {
				t.Fatalf("code = %s, error=%v", connect.CodeOf(err), err)
			}
			if stopped.Load() != 4 {
				t.Fatalf("stopped workers = %d, want 4", stopped.Load())
			}
		})
	}
}

func TestHandlerSnapshotErrorVersusBudget(t *testing.T) {
	for _, test := range []struct {
		name     string
		snapshot func(context.Context) (rpc.Snapshot, error)
		code     connect.Code
		message  string
	}{
		{"snapshot error", func(context.Context) (rpc.Snapshot, error) {
			return rpc.Snapshot{}, errors.New("private provider error")
		}, connect.CodeUnavailable, "could not read quote block"},
		{"budget expires", func(ctx context.Context) (rpc.Snapshot, error) { <-ctx.Done(); return rpc.Snapshot{}, ctx.Err() }, connect.CodeDeadlineExceeded, "search budget expired before snapshot"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := validRequest()
			request.SearchBudgetMs = 10
			client := readerFake{snapshot: test.snapshot, call: func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
				t.Fatal("unexpected contract call")
				return nil, nil
			}}
			_, err := callHandler(context.Background(), client, request)
			if connect.CodeOf(err) != test.code || err == nil || err.Error() != test.code.String()+": "+test.message {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestHandlerValidationBoundaries(t *testing.T) {
	maxUint256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)).String()
	tooLarge := new(big.Int).Lsh(big.NewInt(1), 256).String()
	tests := []struct {
		name   string
		mutate func(*quotev1.QuoteRequest)
		code   connect.Code
	}{
		{"unknown chain", func(r *quotev1.QuoteRequest) { r.Chain = "unknown" }, connect.CodeInvalidArgument},
		{"chain ID mismatch", func(r *quotev1.QuoteRequest) { r.ChainId = "1" }, connect.CodeInvalidArgument},
		{"bad address", func(r *quotev1.QuoteRequest) { r.TokenIn = "0x1234" }, connect.CodeInvalidArgument},
		{"unsupported pair", func(r *quotev1.QuoteRequest) { r.TokenOut = r.TokenIn }, connect.CodeInvalidArgument},
		{"zero amount", func(r *quotev1.QuoteRequest) { r.AmountInAtomic = "0" }, connect.CodeInvalidArgument},
		{"signed amount", func(r *quotev1.QuoteRequest) { r.AmountInAtomic = "+1" }, connect.CodeInvalidArgument},
		{"uint256 overflow", func(r *quotev1.QuoteRequest) { r.AmountInAtomic = tooLarge }, connect.CodeInvalidArgument},
		{"zero budget", func(r *quotev1.QuoteRequest) { r.SearchBudgetMs = 0 }, connect.CodeInvalidArgument},
	}
	client := readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) {
		t.Fatal("invalid input reached snapshot")
		return rpc.Snapshot{}, nil
	}}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			r := validRequest()
			test.mutate(r)
			_, err := callHandler(context.Background(), client, r)
			if connect.CodeOf(err) != test.code {
				t.Fatalf("code = %s, error=%v", connect.CodeOf(err), err)
			}
		})
	}
	t.Run("maximum uint256 and positive budget accepted", func(t *testing.T) {
		r := validRequest()
		r.AmountInAtomic = maxUint256
		r.SearchBudgetMs = 4294967295
		missing := readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil }, call: func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
			return make([]byte, 32), nil
		}}
		got, err := callHandler(context.Background(), missing, r)
		if err != nil || len(got.Routes) != 0 || len(got.Errors) != 0 || !got.SearchComplete {
			t.Fatalf("valid boundary result=%+v error=%v", got, err)
		}
	})
}

func TestHandlerEmptyResultsDistinguishMissingPoolsFromFailures(t *testing.T) {
	for _, fail := range []bool{false, true} {
		client := readerFake{
			snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
			call: func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
				if fail {
					return nil, errors.New("unavailable")
				}
				return make([]byte, 32), nil
			},
		}
		request := validRequest()
		request.TokenIn, request.TokenOut = request.TokenOut, request.TokenIn
		request.AmountInAtomic = "1"
		got, err := callHandler(context.Background(), client, request)
		if err != nil || len(got.Routes) != 0 || !got.SearchComplete {
			t.Fatalf("%+v %v", got, err)
		}
		wantErrors := 0
		if fail {
			wantErrors = 4
		}
		if len(got.Errors) != wantErrors {
			t.Fatalf("errors = %v", got.Errors)
		}
	}
}

func TestStatusSortedWithStartupStateAndBaseTokens(t *testing.T) {
	client := readerFake{}
	handler := Handler{Chains: map[string]Chain{
		"z-test": {ChainID: "84532", Error: "RPC unavailable"},
		"base":   {ChainID: "8453", Client: client, Snapshot: snapshot()},
	}}
	response, err := handler.GetStatus(context.Background(), connect.NewRequest(&quotev1.GetStatusRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	chains := response.Msg.Chains
	if len(chains) != 2 || chains[0].Key != "base" || chains[1].Key != "z-test" {
		t.Fatalf("chains not sorted: %+v", chains)
	}
	if !chains[0].Connected || !chains[0].QuotingSupported || len(chains[0].Tokens) != 2 || chains[0].Tokens[0].Symbol != "WETH" || chains[0].Block.Hash != blockHash {
		t.Fatalf("wrong Base status: %+v", chains[0])
	}
	if chains[1].Connected || chains[1].QuotingSupported || chains[1].Error != "RPC unavailable" || chains[1].Block != nil {
		t.Fatalf("wrong unavailable status: %+v", chains[1])
	}
}

func TestQuoteRejectsUnavailableAndUnsupportedChains(t *testing.T) {
	request := validRequest()
	for _, test := range []struct {
		name    string
		chain   Chain
		want    connect.Code
		chainID string
	}{
		{"unavailable", Chain{ChainID: "8453", Error: "offline"}, connect.CodeUnavailable, "8453"},
		{"unsupported", Chain{ChainID: "1", Client: readerFake{}}, connect.CodeFailedPrecondition, "1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request.ChainId = test.chainID
			_, err := (Handler{Chains: map[string]Chain{"base": test.chain}}).GetQuote(context.Background(), connect.NewRequest(request))
			if connect.CodeOf(err) != test.want {
				t.Fatalf("code = %s, error = %v", connect.CodeOf(err), err)
			}
		})
	}
}
