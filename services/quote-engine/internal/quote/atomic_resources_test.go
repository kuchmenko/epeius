package quote

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1/atomicv1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type atomicLimitFixture struct {
	atomicv1connect.UnimplementedAtomicPlanServiceHandler
	response  *atomicv1.PlanQuoteResponse
	calls     atomic.Int32
	reader    atomic.Int32
	quoter    atomic.Int32
	simulator atomic.Int32
	store     atomic.Int32
}

func gzipSize(t *testing.T, data []byte) int {
	t.Helper()
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Len()
}

func (f *atomicLimitFixture) GetPlanQuote(context.Context, *connect.Request[atomicv1.PlanQuoteRequest]) (*connect.Response[atomicv1.PlanQuoteResponse], error) {
	f.calls.Add(1)
	f.reader.Add(1)
	f.quoter.Add(1)
	f.simulator.Add(1)
	f.store.Add(1)
	return connect.NewResponse(proto.CloneOf(f.response)), nil
}

func (f *atomicLimitFixture) PreparePlan(context.Context, *connect.Request[atomicv1.PreparePlanRequest]) (*connect.Response[atomicv1.PreparePlanResponse], error) {
	f.calls.Add(1)
	return connect.NewResponse(&atomicv1.PreparePlanResponse{}), nil
}

func (f *atomicLimitFixture) RecheckPlan(context.Context, *connect.Request[atomicv1.RecheckPlanRequest]) (*connect.Response[atomicv1.PreparePlanResponse], error) {
	f.calls.Add(1)
	return connect.NewResponse(&atomicv1.PreparePlanResponse{}), nil
}

func TestAtomicTransportLimitsBinaryJSONAndCompressionBeforeService(t *testing.T) {
	request := atomicQuoteRequest("8453", testWETH, testUSDC, "37")
	request.AmountIn = bytes.Repeat([]byte{0x11}, 4096)
	jsonBytes, err := protojson.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		json       bool
		compressed bool
		size       int
	}{
		{"binary", false, false, proto.Size(request)},
		{"binary gzip", false, true, proto.Size(request)},
		{"json", true, false, len(jsonBytes)},
		{"json gzip", true, true, len(jsonBytes)},
	}
	binaryBytes, _ := proto.Marshal(request)
	t.Logf("adversarial request binary=%d binary_gzip=%d json=%d json_gzip=%d", len(binaryBytes), gzipSize(t, binaryBytes), len(jsonBytes), gzipSize(t, jsonBytes))
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, delta := range []int{0, -1} {
				fixture := &atomicLimitFixture{response: &atomicv1.PlanQuoteResponse{QuoteId: bytes.Repeat([]byte{1}, 32), SearchComplete: proto.Bool(true)}}
				path, handler := atomicv1connect.NewAtomicPlanServiceHandler(fixture, connect.WithReadMaxBytes(test.size+delta))
				mux := http.NewServeMux()
				mux.Handle(path, handler)
				server := httptest.NewServer(mux)
				options := []connect.ClientOption{}
				if test.json {
					options = append(options, connect.WithProtoJSON())
				}
				if test.compressed {
					options = append(options, connect.WithSendGzip())
				}
				client := atomicv1connect.NewAtomicPlanServiceClient(server.Client(), server.URL, options...)
				_, callErr := client.GetPlanQuote(t.Context(), connect.NewRequest(proto.CloneOf(request)))
				server.Close()
				if delta == 0 {
					if callErr != nil || fixture.calls.Load() != 1 {
						t.Fatalf("exact limit rejected: calls=%d err=%v", fixture.calls.Load(), callErr)
					}
				} else if connect.CodeOf(callErr) != connect.CodeResourceExhausted || fixture.calls.Load() != 0 || fixture.reader.Load() != 0 || fixture.quoter.Load() != 0 || fixture.simulator.Load() != 0 || fixture.store.Load() != 0 {
					t.Fatalf("oversize reached service work: calls=%d reader=%d quoter=%d simulator=%d store=%d err=%v", fixture.calls.Load(), fixture.reader.Load(), fixture.quoter.Load(), fixture.simulator.Load(), fixture.store.Load(), callErr)
				}
			}
		})
	}
}

func TestAtomicTransportResponseLimit(t *testing.T) {
	response := &atomicv1.PlanQuoteResponse{QuoteId: bytes.Repeat([]byte{1}, 32), Candidates: []*atomicv1.PlanCandidate{{CandidateId: bytes.Repeat([]byte{2}, 4096)}}, SearchComplete: proto.Bool(true)}
	encoded, err := proto.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	jsonEncoded, err := protojson.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	compressedBytes := gzipSize(t, encoded)
	compressedJSONBytes := gzipSize(t, jsonEncoded)
	t.Logf("adversarial response binary=%d binary_gzip=%d json=%d json_gzip=%d", len(encoded), compressedBytes, len(jsonEncoded), compressedJSONBytes)
	for _, test := range []struct {
		name         string
		json         bool
		encodedBytes int
		compressMin  int
	}{
		{"binary", false, len(encoded), len(encoded) + 1},
		{"binary gzip", false, compressedBytes, 0},
		{"json", true, len(jsonEncoded), len(jsonEncoded) + 1},
		{"json gzip", true, compressedJSONBytes, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, delta := range []int{0, -1} {
				fixture := &atomicLimitFixture{response: response}
				path, handler := atomicv1connect.NewAtomicPlanServiceHandler(fixture, connect.WithSendMaxBytes(test.encodedBytes+delta), connect.WithCompressMinBytes(test.compressMin))
				mux := http.NewServeMux()
				mux.Handle(path, handler)
				server := httptest.NewServer(mux)
				options := []connect.ClientOption{}
				if test.json {
					options = append(options, connect.WithProtoJSON())
				}
				client := atomicv1connect.NewAtomicPlanServiceClient(server.Client(), server.URL, options...)
				_, callErr := client.GetPlanQuote(t.Context(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
				server.Close()
				if delta == 0 && callErr != nil {
					t.Fatalf("exact response limit rejected: %v", callErr)
				}
				if delta == -1 && connect.CodeOf(callErr) != connect.CodeResourceExhausted {
					t.Fatalf("oversize response error=%v", callErr)
				}
			}
		})
	}
}

func TestAtomicTransportRequestLimitCoversEveryMethod(t *testing.T) {
	fixture := &atomicLimitFixture{response: &atomicv1.PlanQuoteResponse{}}
	path, handler := atomicv1connect.NewAtomicPlanServiceHandler(fixture, connect.WithReadMaxBytes(64))
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := atomicv1connect.NewAtomicPlanServiceClient(server.Client(), server.URL)
	quoteRequest := &atomicv1.PlanQuoteRequest{AmountIn: bytes.Repeat([]byte{1}, 65)}
	prepareRequest := &atomicv1.PreparePlanRequest{PlanId: bytes.Repeat([]byte{1}, 65)}
	recheckRequest := &atomicv1.RecheckPlanRequest{PlanId: bytes.Repeat([]byte{1}, 65)}
	for name, call := range map[string]func() error{
		"GetPlanQuote": func() error { _, err := client.GetPlanQuote(t.Context(), connect.NewRequest(quoteRequest)); return err },
		"PreparePlan": func() error {
			_, err := client.PreparePlan(t.Context(), connect.NewRequest(prepareRequest))
			return err
		},
		"RecheckPlan": func() error {
			_, err := client.RecheckPlan(t.Context(), connect.NewRequest(recheckRequest))
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := call(); connect.CodeOf(err) != connect.CodeResourceExhausted {
				t.Fatalf("error=%v", err)
			}
		})
	}
	if fixture.calls.Load() != 0 {
		t.Fatalf("oversize request reached %d methods", fixture.calls.Load())
	}
}

func TestAtomicResponseRejectedBeforeStore(t *testing.T) {
	var reads atomic.Int32
	middle := bytes.Repeat([]byte{0x22}, 20)
	reader := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) {
			reads.Add(1)
			return snapshot(), nil
		},
		call: func(_ context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
			reads.Add(1)
			if to == testFactory {
				return poolResponse(common.BytesToAddress(data)), nil
			}
			return quoteResponse(123), nil
		},
	}
	store := NewStore(AtomicStoreLimits{MaxQuotes: 4, MaxQuoteBytes: 4096, MaxPreparations: 4, MaxPreparationBytes: 4096})
	handler := Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: atomicQuoteConfig(common.BytesToAddress(middle))}}, Store: store, QuoteConcurrency: 1, AtomicLimits: AtomicLimits{MaxRequestBytes: 4096, MaxResponseBytes: 1}}
	_, err := handler.GetPlanQuote(t.Context(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	if connect.CodeOf(err) != connect.CodeResourceExhausted || reads.Load() == 0 {
		t.Fatalf("error=%v reads=%d", err, reads.Load())
	}
	if len(store.atomicQuotes) != 0 || store.atomicQuoteBytes != 0 {
		t.Fatal("oversize response was retained")
	}
}

func TestAtomicResponseEncodedBoundary(t *testing.T) {
	response := &atomicv1.PlanQuoteResponse{QuoteId: bytes.Repeat([]byte{1}, 32), Candidates: []*atomicv1.PlanCandidate{{CandidateId: bytes.Repeat([]byte{2}, 32)}}, SearchComplete: proto.Bool(true)}
	jsonBytes, err := protojson.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	allowed := len(jsonBytes)
	if proto.Size(response) > allowed {
		allowed = proto.Size(response)
	}
	if err := (Handler{AtomicLimits: AtomicLimits{MaxResponseBytes: allowed}}).checkAtomicResponse(response); err != nil {
		t.Fatalf("exact encoded response limit rejected: %v", err)
	}
	if err := (Handler{AtomicLimits: AtomicLimits{MaxResponseBytes: allowed - 1}}).checkAtomicResponse(response); connect.CodeOf(err) != connect.CodeResourceExhausted || !strings.Contains(err.Error(), fmt.Sprintf("size %d exceeds configured limit %d", allowed, allowed-1)) {
		t.Fatalf("wrong encoded response limit error: %v", err)
	}
}

func TestAtomicStoreCountBytesExpiryAndDeterministicEviction(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	quote := func(marker byte, padding int) *atomicv1.PlanQuoteResponse {
		return &atomicv1.PlanQuoteResponse{QuoteId: bytes.Repeat([]byte{marker}, 32), Candidates: []*atomicv1.PlanCandidate{{CandidateId: bytes.Repeat([]byte{marker}, padding)}}, SearchComplete: proto.Bool(true)}
	}
	a, b, c := quote(1, 32), quote(2, 32), quote(3, 32)
	one := atomicQuoteRetainedBytes("base", a)
	store := NewStore(AtomicStoreLimits{MaxQuotes: 2, MaxQuoteBytes: one * 2, MaxPreparations: 2, MaxPreparationBytes: 4096})
	if err := store.saveAtomicQuote("base", a, now); err != nil {
		t.Fatal(err)
	}
	if err := store.saveAtomicQuote("base", b, now); err != nil {
		t.Fatal(err)
	}
	if store.atomicQuoteBytes != one*2 || len(store.atomicQuotes) != 2 {
		t.Fatal("exact quote limits not retained")
	}
	if err := store.saveAtomicQuote("base", c, now); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.atomicQuote(a.QuoteId, now); ok {
		t.Fatal("equal-expiry eviction was not deterministic by ID")
	}
	oversize := quote(9, int(one*2))
	beforeBytes, beforeCount := store.atomicQuoteBytes, len(store.atomicQuotes)
	if err := store.saveAtomicQuote("base", oversize, now); err == nil {
		t.Fatal("oversize quote admitted")
	}
	if store.atomicQuoteBytes != beforeBytes || len(store.atomicQuotes) != beforeCount {
		t.Fatal("rejected quote evicted retained entries")
	}
	oneOver := quote(9, 33)
	oneOverLimit := atomicQuoteRetainedBytes("base", oneOver) - 1
	oneOverStore := NewStore(AtomicStoreLimits{MaxQuotes: 2, MaxQuoteBytes: oneOverLimit, MaxPreparations: 1, MaxPreparationBytes: 1})
	if err := oneOverStore.saveAtomicQuote("base", oneOver, now); err == nil || oneOverStore.atomicQuoteBytes != 0 || len(oneOverStore.atomicQuotes) != 0 {
		t.Fatal("quote one byte over its limit was admitted or changed retained state")
	}
	store.prune(now.Add(retention))
	if store.atomicQuoteBytes != 0 || len(store.atomicQuotes) != 0 {
		t.Fatal("expired quote bytes remained counted")
	}

	prepared := func(marker byte, padding int) atomicPreparation {
		return atomicPreparation{response: &atomicv1.PreparePlanResponse{Preparation: &atomicv1.UnsignedPreparation{PreparationId: bytes.Repeat([]byte{marker}, 32), PlanId: bytes.Repeat([]byte{marker}, padding)}}, chain: "base", expires: now.Add(retention), executorPlanHash: bytes.Repeat([]byte{marker}, 32)}
	}
	p := prepared(4, 32)
	prepBytes := atomicPreparationRetainedBytes(p)
	prepStore := NewStore(AtomicStoreLimits{MaxQuotes: 1, MaxQuoteBytes: 1, MaxPreparations: 1, MaxPreparationBytes: prepBytes})
	if err := prepStore.saveAtomicPreparation(p, now); err != nil || prepStore.atomicPreparationBytes != prepBytes {
		t.Fatalf("exact preparation limit rejected: %v", err)
	}
	if err := prepStore.saveAtomicPreparation(prepared(5, int(prepBytes)), now); err == nil || prepStore.atomicPreparationBytes != prepBytes {
		t.Fatal("oversize preparation changed retained state")
	}
	prepOneOver := prepared(6, 33)
	prepOneOverLimit := atomicPreparationRetainedBytes(prepOneOver) - 1
	prepOneOverStore := NewStore(AtomicStoreLimits{MaxQuotes: 1, MaxQuoteBytes: 1, MaxPreparations: 1, MaxPreparationBytes: prepOneOverLimit})
	if err := prepOneOverStore.saveAtomicPreparation(prepOneOver, now); err == nil || prepOneOverStore.atomicPreparationBytes != 0 || len(prepOneOverStore.atomicPlans) != 0 {
		t.Fatal("preparation one byte over its limit was admitted or changed retained state")
	}
	countStore := NewStore(AtomicStoreLimits{MaxQuotes: 1, MaxQuoteBytes: 1, MaxPreparations: 2, MaxPreparationBytes: prepBytes * 2})
	if err := countStore.saveAtomicPreparation(prepared(1, 32), now); err != nil {
		t.Fatal(err)
	}
	if err := countStore.saveAtomicPreparation(prepared(2, 32), now); err != nil {
		t.Fatal(err)
	}
	if err := countStore.saveAtomicPreparation(prepared(3, 32), now); err != nil {
		t.Fatal(err)
	}
	if _, ok := countStore.atomicPreparation(bytes.Repeat([]byte{1}, 32), now); ok {
		t.Fatal("equal-expiry preparation eviction was not deterministic by ID")
	}
}

func TestAtomicStoreConcurrentAdmissionStaysWithinLimits(t *testing.T) {
	limits := AtomicStoreLimits{MaxQuotes: 8, MaxQuoteBytes: 2048, MaxPreparations: 1, MaxPreparationBytes: 1}
	store := NewStore(limits)
	now := time.Unix(1_700_000_000, 0)
	var workers sync.WaitGroup
	for marker := byte(1); marker <= 64; marker++ {
		workers.Add(1)
		go func(marker byte) {
			defer workers.Done()
			response := &atomicv1.PlanQuoteResponse{QuoteId: bytes.Repeat([]byte{marker}, 32), Candidates: []*atomicv1.PlanCandidate{{CandidateId: bytes.Repeat([]byte{marker}, 64)}}}
			if err := store.saveAtomicQuote("base", response, now); err != nil {
				t.Error(err)
			}
		}(marker)
	}
	workers.Wait()
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.atomicQuotes) > int(limits.MaxQuotes) || store.atomicQuoteBytes > limits.MaxQuoteBytes {
		t.Fatalf("count=%d bytes=%d", len(store.atomicQuotes), store.atomicQuoteBytes)
	}
}

type compositionResourceFixture struct {
	Profiles []struct {
		Name     string `json:"name"`
		Branches []int  `json:"branches"`
		Calldata string `json:"calldata"`
	} `json:"profiles"`
}

func compositionResourceMessages(t *testing.T, branches []int, calldata string) (*atomicv1.PreparePlanRequest, *atomicv1.PlanQuoteResponse, *atomicv1.PreparePlanResponse) {
	t.Helper()
	program := &atomicv1.PlanProgram{FormatVersion: proto.Uint32(1), ChainId: bytes.Repeat([]byte{1}, 32), TokenIn: bytes.Repeat([]byte{2}, 20), TokenOut: bytes.Repeat([]byte{3}, 20), AmountIn: bytes.Repeat([]byte{4}, 32)}
	branchQuotes := make([]*atomicv1.BranchQuote, len(branches))
	for i, count := range branches {
		branch := &atomicv1.PlanBranch{AmountIn: bytes.Repeat([]byte{byte(i + 5)}, 32)}
		quote := &atomicv1.BranchQuote{}
		for operation := 0; operation < count; operation++ {
			branch.Operations = append(branch.Operations, &atomicv1.PoolOperation{TokenIn: bytes.Repeat([]byte{byte(operation + 10)}, 20), TokenOut: bytes.Repeat([]byte{byte(operation + 11)}, 20), Pool: &atomicv1.PoolOperation_UniswapV3{UniswapV3: &atomicv1.V3Pool{Factory: bytes.Repeat([]byte{12}, 20), Router: bytes.Repeat([]byte{13}, 20), Pool: bytes.Repeat([]byte{byte(operation + 14)}, 20), FeePips: proto.Uint32(3000)}}})
			quote.OperationOutputs = append(quote.OperationOutputs, bytes.Repeat([]byte{byte(operation + 20)}, 32))
		}
		program.Branches = append(program.Branches, branch)
		branchQuotes[i] = quote
	}
	terms := &atomicv1.AcceptedPlanTerms{Program: proto.CloneOf(program), Executor: &atomicv1.ExecutorIdentity{Address: bytes.Repeat([]byte{30}, 20), Version: proto.Uint32(2), RuntimeCodeHash: bytes.Repeat([]byte{31}, 32)}, Signer: bytes.Repeat([]byte{32}, 20), Recipient: bytes.Repeat([]byte{32}, 20), QuoteBlock: &atomicv1.PinnedBlock{Number: bytes.Repeat([]byte{33}, 32), Hash: bytes.Repeat([]byte{34}, 32)}, AmountOutMinimum: bytes.Repeat([]byte{35}, 32), ExpiresAtUnix: bytes.Repeat([]byte{36}, 32), DeadlineUnix: bytes.Repeat([]byte{37}, 32)}
	for range branches {
		terms.BranchMinima = append(terms.BranchMinima, bytes.Repeat([]byte{38}, 32))
	}
	request := &atomicv1.PreparePlanRequest{QuoteId: bytes.Repeat([]byte{39}, 32), CandidateId: bytes.Repeat([]byte{40}, 32), Terms: terms, PlanId: bytes.Repeat([]byte{41}, 32)}
	quoteResponse := &atomicv1.PlanQuoteResponse{QuoteId: bytes.Repeat([]byte{42}, 32), Candidates: []*atomicv1.PlanCandidate{{CandidateId: bytes.Repeat([]byte{43}, 32), Program: proto.CloneOf(program), QuoteBlock: proto.CloneOf(terms.QuoteBlock), BranchQuotes: branchQuotes}}, SearchComplete: proto.Bool(true)}
	data, err := hex.DecodeString(calldata[2:])
	if err != nil {
		t.Fatal(err)
	}
	transaction := &atomicv1.PlanTransaction{ChainId: bytes.Repeat([]byte{1}, 32), From: bytes.Repeat([]byte{32}, 20), To: bytes.Repeat([]byte{30}, 20), Data: data, Value: make([]byte, 32), GasLimit: bytes.Repeat([]byte{44}, 32)}
	preparationResponse := &atomicv1.PreparePlanResponse{Status: atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY.Enum(), Preparation: &atomicv1.UnsignedPreparation{PreparationId: bytes.Repeat([]byte{45}, 32), PlanId: bytes.Repeat([]byte{41}, 32), Terms: proto.CloneOf(terms), Transaction: transaction}, Simulation: &atomicv1.SimulationEvidence{PlanId: bytes.Repeat([]byte{41}, 32), PreparationId: bytes.Repeat([]byte{45}, 32), TransactionFingerprint: bytes.Repeat([]byte{46}, 32), Block: proto.CloneOf(terms.QuoteBlock), Status: atomicv1.SimulationStatus_SIMULATION_STATUS_PASSED.Enum(), BranchResults: branchQuotes, ObservedAtUnix: bytes.Repeat([]byte{47}, 32)}}
	return request, quoteResponse, preparationResponse
}

func TestAtomicResourceMeasurements(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/fixtures/executor-v2-composition.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture compositionResourceFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, profile := range fixture.Profiles {
		request, quoteResponse, preparationResponse := compositionResourceMessages(t, profile.Branches, profile.Calldata)
		requestJSON, _ := protojson.Marshal(request)
		quoteJSON, _ := protojson.Marshal(quoteResponse)
		preparationJSON, _ := protojson.Marshal(preparationResponse)
		stored := atomicPreparation{response: preparationResponse, chain: "base", executorPlanHash: bytes.Repeat([]byte{1}, 32), checks: SimulationChecks{Preserve: []BalanceProbe{{Token: testWETH.Hex(), Owner: testUSDC.Hex()}}}}
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		allocations := testing.AllocsPerRun(100, func() {
			clone := proto.CloneOf(preparationResponse)
			_, _ = proto.Marshal(clone)
		})
		runtime.ReadMemStats(&after)
		t.Logf("profile=%s request_proto=%d request_json=%d quote_response_proto=%d quote_response_json=%d preparation_response_proto=%d preparation_response_json=%d retained_quote=%d retained_preparation=%d allocations=%.0f heap_alloc_delta=%d heap_total_alloc_delta=%d", profile.Name, proto.Size(request), len(requestJSON), proto.Size(quoteResponse), len(quoteJSON), proto.Size(preparationResponse), len(preparationJSON), atomicQuoteRetainedBytes("base", quoteResponse), atomicPreparationRetainedBytes(stored), allocations, int64(after.HeapAlloc)-int64(before.HeapAlloc), after.TotalAlloc-before.TotalAlloc)
	}
}
