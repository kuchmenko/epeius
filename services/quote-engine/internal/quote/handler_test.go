package quote

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
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

var (
	testFactory = common.HexToAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD")
	testQuoter  = common.HexToAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a")
	testWETH    = common.HexToAddress("0x4200000000000000000000000000000000000006")
	testUSDC    = common.HexToAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
)

func testChainConfig() config.Chain {
	return config.Chain{
		Tokens:      []config.Token{{Address: testWETH.Hex(), Symbol: "WETH", Decimals: 18}, {Address: testUSDC.Hex(), Symbol: "USDC", Decimals: 6}},
		Deployments: map[string]config.Deployment{"uniswap-v3": {Kind: "uniswap-v3", Factory: testFactory.Hex(), Quoter: testQuoter.Hex(), Fees: []uint32{100, 500, 3000, 10000}}},
	}
}

func snapshot() rpc.Snapshot { return rpc.Snapshot{BlockNumber: "19283746", BlockHash: blockHash} }

func validRequest() *quotev1.QuoteRequest {
	return &quotev1.QuoteRequest{
		Chain: "base", ChainId: "8453",
		TokenIn: testWETH.Hex(), TokenOut: testUSDC.Hex(),
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
	response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: client, Config: testChainConfig()}}, QuoteConcurrency: 4}).GetQuote(ctx, connect.NewRequest(request))
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
			if to == testFactory {
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
	if got.GetBestRouteId() != "uniswap-v3:10000" || got.Routes[0].NetworkCostOutAtomic != nil || got.Routes[0].EffectiveOutAtomic != nil {
		t.Fatal("wrong recommendation or cost fields unexpectedly populated")
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
				if to == testFactory {
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
	if got.GetBestRouteId() != "uniswap-v3:100" {
		t.Fatal("partial search lost its best returned route")
	}
	if len(got.Errors) != 3 {
		t.Fatalf("started candidates missing budget errors: %v", got.Errors)
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
		if err != nil || len(got.Routes) != 0 || !got.SearchComplete || got.BestRouteId != nil {
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

func TestStatusUsesOnlyExplicitChainConfig(t *testing.T) {
	client := readerFake{}
	alternate := testChainConfig()
	alternate.ExecutionEnabled = true
	handler := Handler{Chains: map[string]Chain{
		"z-test": {ChainID: "84532", Error: "RPC unavailable"},
		"base":   {ChainID: "8453", Client: client, Snapshot: snapshot()},
		"other":  {ChainID: "1", Client: client, Config: alternate},
	}, QuoteConcurrency: 4}
	response, err := handler.GetStatus(context.Background(), connect.NewRequest(&quotev1.GetStatusRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	chains := response.Msg.Chains
	if len(chains) != 3 || chains[0].Key != "base" || chains[1].Key != "other" || chains[2].Key != "z-test" {
		t.Fatalf("chains not sorted: %+v", chains)
	}
	if !chains[0].Connected || chains[0].QuotingSupported || chains[0].ExecutionEnabled || len(chains[0].Tokens) != 0 || chains[0].Block.Hash != blockHash {
		t.Fatalf("wrong Base status: %+v", chains[0])
	}
	if !chains[1].Connected || !chains[1].QuotingSupported || !chains[1].ExecutionEnabled || len(chains[1].Tokens) != 2 {
		t.Fatalf("wrong explicitly configured alternate status: %+v", chains[1])
	}
	if chains[2].Connected || chains[2].QuotingSupported || chains[2].Error != "RPC unavailable" || chains[2].Block != nil {
		t.Fatalf("wrong unavailable status: %+v", chains[2])
	}
}

func TestStatusRequiresTwoTokensBeforeAdvertisingQuoteSupport(t *testing.T) {
	allTokens := testChainConfig().Tokens
	for _, test := range []struct {
		name      string
		tokens    []config.Token
		supported bool
	}{
		{name: "no tokens", tokens: nil, supported: false},
		{name: "one token", tokens: allTokens[:1], supported: false},
		{name: "two tokens", tokens: allTokens, supported: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			chainConfig := testChainConfig()
			chainConfig.ExecutionEnabled = false
			chainConfig.Tokens = test.tokens
			got := Status("base", Chain{ChainID: "8453", Client: readerFake{}, Config: chainConfig})
			if got.QuotingSupported != test.supported {
				t.Fatalf("QuotingSupported = %t with %d tokens, want %t", got.QuotingSupported, len(test.tokens), test.supported)
			}
			if got.ExecutionEnabled {
				t.Fatal("read-only deployment advertised execution support")
			}
		})
	}
}

func TestStatusAdvertisedTokenAddressCanBeQuotedVerbatim(t *testing.T) {
	client := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
			return make([]byte, 32), nil
		},
	}
	t.Run("normalized configured address", func(t *testing.T) {
		chainConfig := testChainConfig()
		chain := Chain{ChainID: "8453", Client: client, Config: chainConfig}
		status := Status("base", chain)
		request := validRequest()
		request.TokenIn = status.Tokens[0].Address
		request.TokenOut = status.Tokens[1].Address
		_, err := (Handler{Chains: map[string]Chain{"base": chain}, QuoteConcurrency: 2}).GetQuote(context.Background(), connect.NewRequest(request))
		if err != nil {
			t.Fatalf("GetQuote rejected Status token address %q: %v", request.TokenIn, err)
		}
	})
}

func TestExpiredBudgetDoesNotLaunchCartesianCandidates(t *testing.T) {
	chainConfig := testChainConfig()
	chainConfig.Deployments["uniswap-v3"] = config.Deployment{
		Kind:    "uniswap-v3",
		Factory: testFactory.Hex(),
		Quoter:  testQuoter.Hex(),
		Fees:    []uint32{100, 500, 3000},
	}
	for i := 1; i <= 3; i++ {
		chainConfig.Tokens = append(chainConfig.Tokens, config.Token{Address: common.BigToAddress(big.NewInt(int64(i))).Hex(), Symbol: "M", Decimals: 18})
	}
	candidateCount := 0
	iterator := newCandidates(chainConfig, testWETH, testUSDC)
	for {
		_, _, ok := iterator.next(context.Background())
		if !ok {
			break
		}
		candidateCount++
	}
	wantCartesianCount := 3 + 3*3*3
	if candidateCount != wantCartesianCount {
		t.Fatalf("candidate count = %d, want direct fees + intermediates*fee pairs = %d", candidateCount, wantCartesianCount)
	}

	started := make(chan struct{}, candidateCount)
	release := make(chan struct{})
	client := readerFake{
		snapshot: func(ctx context.Context) (rpc.Snapshot, error) {
			<-ctx.Done()
			return snapshot(), nil
		},
		call: func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
			started <- struct{}{}
			<-release
			return make([]byte, 32), nil
		},
	}
	request := validRequest()
	request.SearchBudgetMs = 1
	done := make(chan error, 1)
	go func() {
		_, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: client, Config: chainConfig}}, QuoteConcurrency: 3}).GetQuote(context.Background(), connect.NewRequest(request))
		done <- err
	}()

	observedCalls := 0
	for observedCalls < candidateCount {
		select {
		case <-started:
			observedCalls++
		case <-done:
			close(release)
			if observedCalls != 0 {
				t.Fatalf("expired budget launched %d RPC calls, want 0", observedCalls)
			}
			return
		case <-time.After(time.Second):
			close(release)
			t.Fatalf("timed out after observing %d of %d candidate calls", observedCalls, candidateCount)
		}
	}
	close(release)
	<-done
	if observedCalls != 0 {
		t.Fatalf("expired budget launched %d concurrent candidate RPC calls from %d Cartesian candidates, want 0", observedCalls, candidateCount)
	}
}

func TestCandidateIteratorDeterministicMultiDeploymentCartesianTraversal(t *testing.T) {
	middleA := common.HexToAddress("0x0000000000000000000000000000000000000001")
	middleB := common.HexToAddress("0x0000000000000000000000000000000000000002")
	chainConfig := config.Chain{
		Tokens: []config.Token{{Address: middleB.Hex()}, {Address: testUSDC.Hex()}, {Address: middleA.Hex()}, {Address: testWETH.Hex()}},
		Deployments: map[string]config.Deployment{
			"zeta":  {Fees: []uint32{500}},
			"alpha": {Fees: []uint32{3000, 100}},
		},
	}
	want := []candidate{
		{id: "alpha:100", deployment: "alpha", tokens: []common.Address{testWETH, testUSDC}, fees: []uint32{100}},
		{id: "alpha:3000", deployment: "alpha", tokens: []common.Address{testWETH, testUSDC}, fees: []uint32{3000}},
		{id: "alpha:100:" + middleA.Hex() + ":100", deployment: "alpha", tokens: []common.Address{testWETH, middleA, testUSDC}, fees: []uint32{100, 100}},
		{id: "alpha:100:" + middleA.Hex() + ":3000", deployment: "alpha", tokens: []common.Address{testWETH, middleA, testUSDC}, fees: []uint32{100, 3000}},
		{id: "alpha:3000:" + middleA.Hex() + ":100", deployment: "alpha", tokens: []common.Address{testWETH, middleA, testUSDC}, fees: []uint32{3000, 100}},
		{id: "alpha:3000:" + middleA.Hex() + ":3000", deployment: "alpha", tokens: []common.Address{testWETH, middleA, testUSDC}, fees: []uint32{3000, 3000}},
		{id: "alpha:100:" + middleB.Hex() + ":100", deployment: "alpha", tokens: []common.Address{testWETH, middleB, testUSDC}, fees: []uint32{100, 100}},
		{id: "alpha:100:" + middleB.Hex() + ":3000", deployment: "alpha", tokens: []common.Address{testWETH, middleB, testUSDC}, fees: []uint32{100, 3000}},
		{id: "alpha:3000:" + middleB.Hex() + ":100", deployment: "alpha", tokens: []common.Address{testWETH, middleB, testUSDC}, fees: []uint32{3000, 100}},
		{id: "alpha:3000:" + middleB.Hex() + ":3000", deployment: "alpha", tokens: []common.Address{testWETH, middleB, testUSDC}, fees: []uint32{3000, 3000}},
		{id: "zeta:500", deployment: "zeta", tokens: []common.Address{testWETH, testUSDC}, fees: []uint32{500}},
		{id: "zeta:500:" + middleA.Hex() + ":500", deployment: "zeta", tokens: []common.Address{testWETH, middleA, testUSDC}, fees: []uint32{500, 500}},
		{id: "zeta:500:" + middleB.Hex() + ":500", deployment: "zeta", tokens: []common.Address{testWETH, middleB, testUSDC}, fees: []uint32{500, 500}},
	}
	iterator := newCandidates(chainConfig, testWETH, testUSDC)
	for index, expected := range want {
		gotIndex, got, ok := iterator.next(context.Background())
		if !ok || gotIndex != index || got.id != expected.id || got.deployment != expected.deployment || !slices.Equal(got.tokens, expected.tokens) || !slices.Equal(got.fees, expected.fees) {
			t.Fatalf("candidate %d = (%d, %+v, %t), want (%d, %+v, true)", index, gotIndex, got, ok, index, expected)
		}
	}
	if _, got, ok := iterator.next(context.Background()); ok {
		t.Fatalf("unexpected candidate after full traversal: %+v", got)
	}
}

func TestQuoteLargeConcurrencyOnlyStartsAvailableWork(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		var calls atomic.Int32
		client := readerFake{
			snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
			call: func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
				calls.Add(1)
				return make([]byte, 32), nil
			},
		}
		chain := Chain{ChainID: "8453", Client: client, Config: testChainConfig()}
		wantCalls, wantErrors := int32(4), 0
		if unavailable {
			chain.DeploymentErrors = map[string]string{"uniswap-v3": "unavailable"}
			wantCalls, wantErrors = 0, 1
		}
		h := Handler{Chains: map[string]Chain{"base": chain}, QuoteConcurrency: int(^uint(0) >> 1)}
		response, err := h.GetQuote(context.Background(), connect.NewRequest(validRequest()))
		if err != nil {
			t.Fatal(err)
		}
		if calls.Load() != wantCalls || len(response.Msg.Errors) != wantErrors || !response.Msg.SearchComplete {
			t.Fatalf("unavailable=%t: calls=%d errors=%d complete=%t", unavailable, calls.Load(), len(response.Msg.Errors), response.Msg.SearchComplete)
		}
	}
}

func TestQuoteConcurrencyBoundsCandidateCalls(t *testing.T) {
	const concurrency = 2
	entered := make(chan struct{}, concurrency+1)
	release := make(chan struct{})
	client := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(ctx context.Context, _ common.Address, _ []byte, _ common.Hash) ([]byte, error) {
			entered <- struct{}{}
			select {
			case <-release:
				return make([]byte, 32), nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	done := make(chan error, 1)
	go func() {
		_, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: client, Config: testChainConfig()}}, QuoteConcurrency: concurrency}).GetQuote(context.Background(), connect.NewRequest(validRequest()))
		done <- err
	}()
	for range concurrency {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("configured workers did not start")
		}
	}
	select {
	case <-entered:
		t.Fatal("candidate calls exceeded engine.quote_concurrency")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
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
			_, err := (Handler{Chains: map[string]Chain{"base": test.chain}, QuoteConcurrency: 4}).GetQuote(context.Background(), connect.NewRequest(request))
			if connect.CodeOf(err) != test.want {
				t.Fatalf("code = %s, error = %v", connect.CodeOf(err), err)
			}
		})
	}
}

func TestQuoteRejectsUnconfiguredConcurrency(t *testing.T) {
	_, err := (Handler{}).GetQuote(context.Background(), connect.NewRequest(validRequest()))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || err.Error() != "failed_precondition: quote concurrency is not configured" {
		t.Fatalf("error = %v", err)
	}
}

func TestBestRouteUsesExactIntegersAndCandidateOrderForTies(t *testing.T) {
	for _, test := range []struct{ first, second, want string }{
		{"9", "10", "uniswap-v3:500"},
		{"9007199254740992", "9007199254740993", "uniswap-v3:500"},
		{"1606938044258990275541962092341162602522202993782792835301377", "1606938044258990275541962092341162602522202993782792835301376", "uniswap-v3:100"},
		{"17", "17", "uniswap-v3:100"},
	} {
		t.Run(test.first+"/"+test.second, func(t *testing.T) {
			secondFinished := make(chan struct{})
			client := readerFake{
				snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
				call: func(ctx context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
					if to == testFactory {
						return poolResponse(testFactory), nil
					}
					value := test.second
					if calldataFee(data) == 100 {
						select {
						case <-secondFinished:
						case <-ctx.Done():
							return nil, ctx.Err()
						}
						time.Sleep(10 * time.Millisecond)
						value = test.first
					} else {
						close(secondFinished)
					}
					amount, _ := new(big.Int).SetString(value, 10)
					response := quoteResponse(1)
					amount.FillBytes(response[:32])
					return response, nil
				},
			}
			cfg := testChainConfig()
			d := cfg.Deployments["uniswap-v3"]
			d.Fees = []uint32{500, 100}
			cfg.Deployments["uniswap-v3"] = d
			h := Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: client, Config: cfg}}, QuoteConcurrency: 2}
			response, err := h.GetQuote(context.Background(), connect.NewRequest(validRequest()))
			if err != nil {
				t.Fatal(err)
			}
			got := response.Msg
			if got.GetBestRouteId() != test.want || !got.SearchComplete || len(got.Errors) != 0 || len(got.Routes) != 2 || got.Routes[0].RouteId != "uniswap-v3:100" || got.Routes[0].AmountOutAtomic != test.first || got.Routes[1].AmountOutAtomic != test.second {
				t.Fatalf("unexpected selection/order: %+v", got)
			}
			for _, route := range got.Routes {
				if route.NetworkCostOutAtomic != nil || route.EffectiveOutAtomic != nil {
					t.Fatal("cost fields populated")
				}
			}
		})
	}
}

func TestBestRouteCanBeDirectOrTwoHopOnEitherVenue(t *testing.T) {
	for _, venue := range []string{"uniswap-v3", "pancake-v3"} {
		for _, twoHop := range []bool{false, true} {
			t.Run(venue+map[bool]string{false: "/direct", true: "/two-hop"}[twoHop], func(t *testing.T) {
				cfg := testChainConfig()
				middle := common.HexToAddress(tokenB)
				cfg.Tokens = append(cfg.Tokens, config.Token{Address: middle.Hex()})
				cakeQuoter := common.HexToAddress(tokenC)
				uni := cfg.Deployments["uniswap-v3"]
				uni.Fees = []uint32{500}
				cfg.Deployments["uniswap-v3"] = uni
				cake := uni
				cake.Kind, cake.Quoter = "pancake-v3", cakeQuoter.Hex()
				cfg.Deployments["pancake-v3"] = cake
				client := readerFake{
					snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
					call: func(_ context.Context, to common.Address, data []byte, block common.Hash) ([]byte, error) {
						if block != common.HexToHash(blockHash) {
							t.Error("unpinned quote")
						}
						if to == testFactory {
							return poolResponse(testFactory), nil
						}
						in, out := common.BytesToAddress(data[4:36]), common.BytesToAddress(data[36:68])
						winningVenue := (to == cakeQuoter) == (venue == "pancake-v3")
						winningLeg := out == testUSDC && ((in == middle) == twoHop)
						if winningVenue && winningLeg {
							return quoteResponse(101), nil
						}
						return quoteResponse(7), nil
					},
				}
				h := Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: client, Config: cfg}}, QuoteConcurrency: 4}
				response, err := h.GetQuote(context.Background(), connect.NewRequest(validRequest()))
				if err != nil {
					t.Fatal(err)
				}
				want := venue + ":500"
				if twoHop {
					want += ":" + middle.Hex() + ":500"
				}
				if response.Msg.GetBestRouteId() != want || len(response.Msg.Routes) != 4 || len(response.Msg.Errors) != 0 || !response.Msg.SearchComplete {
					t.Fatalf("%+v", response.Msg)
				}
			})
		}
	}
}

func TestQuotePathSequentialInputsAndMissingVersusError(t *testing.T) {
	for _, mode := range []string{"complete", "missing", "error"} {
		t.Run(mode, func(t *testing.T) {
			tokens := []common.Address{common.HexToAddress(tokenA), common.HexToAddress(tokenB), common.HexToAddress(tokenC)}
			fees := []uint32{0, 999999}
			calls := 0
			client := readerFake{call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
				hop := calls / 2
				quoter := calls%2 == 1
				calls++
				if hash != common.HexToHash(blockHash) || common.BytesToAddress(data[4:36]) != tokens[hop] || common.BytesToAddress(data[36:68]) != tokens[hop+1] || calldataFee(data) != fees[hop] {
					t.Fatal("path tokens, fees or pinned hash changed")
				}
				if !quoter {
					if to != testFactory {
						t.Fatal("wrong factory")
					}
					if hop == 1 && mode == "missing" {
						return make([]byte, 32), nil
					}
					if hop == 1 && mode == "error" {
						return nil, errors.New("private RPC failure")
					}
					return poolResponse(tokens[hop]), nil
				}
				if to != testQuoter || new(big.Int).SetBytes(data[68:100]).Uint64() != []uint64{37, 79}[hop] {
					t.Fatal("hop did not use exact preceding output")
				}
				return quoteResponse([]uint64{79, 173}[hop]), nil
			}}
			amount := big.NewInt(37)
			legs, output, err := quotePath(context.Background(), client, config.Deployment{Factory: testFactory.Hex(), Quoter: testQuoter.Hex()}, tokens, fees, amount, common.HexToHash(blockHash))
			if amount.Int64() != 37 {
				t.Fatal("input amount mutated")
			}
			if mode == "complete" {
				if err != nil || output.String() != "173" || len(legs) != 2 || legs[1].Pool != tokenB || calls != 4 {
					t.Fatal("incomplete path result")
				}
			} else if output != nil || legs != nil || (err != nil) != (mode == "error") || calls != 3 {
				t.Fatal("missing path confused with RPC failure")
			}
		})
	}
}

func TestSearchKeepsSameKindDeploymentsSeparateFromExecutor(t *testing.T) {
	cfg := testChainConfig()
	d := cfg.Deployments["uniswap-v3"]
	d.Fees = []uint32{500}
	cfg.Deployments = map[string]config.Deployment{"configured": d, "other": d}
	cfg.Executor = &config.Executor{UniswapDeployment: "configured", PancakeDeployment: "pancake"}
	client := readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil }, call: func(_ context.Context, to common.Address, _ []byte, _ common.Hash) ([]byte, error) {
		if to == testFactory {
			return poolResponse(common.HexToAddress(tokenA)), nil
		}
		return quoteResponse(173), nil
	}}
	h := Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: client, Config: cfg}}, QuoteConcurrency: 2}
	response, err := h.GetQuote(context.Background(), connect.NewRequest(validRequest()))
	if err != nil || len(response.Msg.Routes) != 2 {
		t.Fatal("search hid same-kind deployment", err)
	}
	for _, route := range response.Msg.Routes {
		venue, err := executorVenue(cfg, route)
		if (err == nil) != (route.DeploymentId == "configured") || err == nil && venue != 0 {
			t.Fatal("executor used kind instead of deployment membership")
		}
	}
}
