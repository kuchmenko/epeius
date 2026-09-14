package quote

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

type atomicCandidateFixture struct {
	FormatVersion     uint32   `json:"formatVersion"`
	ChainID           string   `json:"chainId"`
	TokenIn           string   `json:"tokenIn"`
	IntermediateToken string   `json:"intermediateToken"`
	TokenOut          string   `json:"tokenOut"`
	AmountIn          string   `json:"amountIn"`
	Factory           string   `json:"factory"`
	Router            string   `json:"router"`
	Pools             []string `json:"pools"`
	Fees              []uint32 `json:"fees"`
	OperationOutputs  []string `json:"operationOutputs"`
	QuoteBlockNumber  string   `json:"quoteBlockNumber"`
	QuoteBlockHash    string   `json:"quoteBlockHash"`
	CandidateID       string   `json:"candidateId"`
}

func loadAtomicCandidateFixture(t *testing.T) atomicCandidateFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-candidate.json")
	if err != nil {
		t.Fatal(err)
	}
	var result atomicCandidateFixture
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestAtomicCandidateHashMatchesIndependentCastVector(t *testing.T) {
	f := loadAtomicCandidateFixture(t)
	chainID, _ := new(big.Int).SetString(f.ChainID, 10)
	amount, _ := new(big.Int).SetString(f.AmountIn, 10)
	blockNumber, _ := new(big.Int).SetString(f.QuoteBlockNumber, 10)
	outputs := make([]*big.Int, len(f.OperationOutputs))
	for i, value := range f.OperationOutputs {
		outputs[i], _ = new(big.Int).SetString(value, 10)
	}
	item := candidate{
		tokens: []common.Address{common.HexToAddress(f.TokenIn), common.HexToAddress(f.IntermediateToken), common.HexToAddress(f.TokenOut)},
		fees:   f.Fees,
	}
	pools := []common.Address{common.HexToAddress(f.Pools[0]), common.HexToAddress(f.Pools[1])}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(f.QuoteBlockHash).Bytes()}
	value, err := atomicPlanCandidate(chainID, amount, common.HexToAddress(f.TokenIn), common.HexToAddress(f.TokenOut), config.Deployment{Factory: f.Factory, Router: f.Router}, item, block, outputs, pools)
	if err != nil {
		t.Fatal(err)
	}
	if common.BytesToHash(value.CandidateId).Hex() != f.CandidateID || len(value.BranchQuotes) != 1 || len(value.BranchQuotes[0].OperationOutputs) != 2 || new(big.Int).SetBytes(value.BranchQuotes[0].OperationOutputs[0]).String() != f.OperationOutputs[0] {
		t.Fatalf("candidate does not match Cast vector: %+v", value)
	}
}

func atomicQuoteRequest(chainID string, in, out common.Address, amount string) *atomicv1.PlanQuoteRequest {
	chain, _ := new(big.Int).SetString(chainID, 10)
	input, _ := new(big.Int).SetString(amount, 10)
	return &atomicv1.PlanQuoteRequest{
		FormatVersion: proto.Uint32(1), ChainId: uint256Bytes(chain), TokenIn: in.Bytes(), TokenOut: out.Bytes(), AmountIn: uint256Bytes(input), SearchBudgetMs: proto.Uint32(500),
	}
}

func atomicQuoteConfig(middle common.Address) config.Chain {
	return config.Chain{
		Tokens:         []config.Token{{Address: testWETH.Hex()}, {Address: middle.Hex()}, {Address: testUSDC.Hex()}},
		Deployments:    map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: testFactory.Hex(), Quoter: testQuoter.Hex(), Router: common.HexToAddress("0x5555").Hex(), Fees: []uint32{3000, 500}}},
		AtomicExecutor: &config.AtomicExecutor{Address: common.HexToAddress("0x4444").Hex(), RuntimeCodeHash: common.HexToHash("0x11").Hex(), UniswapDeployment: "uni"},
	}
}

func TestAtomicPlanQuoteCanonicalPathsUseSequentialOutputs(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	reader := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
			if hash != common.HexToHash(blockHash) {
				t.Fatal("quote did not use the pinned block")
			}
			if to == testFactory {
				return poolResponse(common.BytesToAddress(crypto.Keccak256(data)[12:])), nil
			}
			if calldataFee(data) == 500 {
				time.Sleep(3 * time.Millisecond)
			}
			input := new(big.Int).SetBytes(data[68:100]).Uint64()
			return quoteResponse(input*2 + uint64(calldataFee(data))), nil
		},
	}
	handler := Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: atomicQuoteConfig(middle)}}, QuoteConcurrency: 3}
	response, err := handler.GetPlanQuote(context.Background(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	if err != nil {
		t.Fatal(err)
	}
	got := response.Msg
	if got.SearchComplete == nil || !got.GetSearchComplete() || len(got.QuoteId) != 32 || len(got.Candidates) != 6 {
		t.Fatalf("unexpected result: %+v", got)
	}
	wantHops := []int{1, 1, 2, 2, 2, 2}
	for i, value := range got.Candidates {
		operations := value.Program.Branches[0].Operations
		outputs := value.BranchQuotes[0].OperationOutputs
		if len(operations) != wantHops[i] || len(outputs) != wantHops[i] || value.NetworkCostOut != nil || len(value.CandidateId) != 32 {
			t.Fatalf("candidate %d has wrong structure", i)
		}
		if len(outputs) == 2 {
			first := new(big.Int).SetBytes(outputs[0]).Uint64()
			second := new(big.Int).SetBytes(outputs[1]).Uint64()
			secondFee := uint64(operations[1].GetUniswapV3().GetFeePips())
			if second != first*2+secondFee {
				t.Fatalf("candidate %d did not preserve sequential outputs", i)
			}
		}
	}
	if got.Candidates[0].Program.Branches[0].Operations[0].GetUniswapV3().GetFeePips() != 500 || got.Candidates[1].Program.Branches[0].Operations[0].GetUniswapV3().GetFeePips() != 3000 {
		t.Fatal("direct candidates are not in canonical fee order")
	}
}

func TestAtomicPlanQuoteRejectsMalformedAndAmbiguousRequests(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	chain := Chain{ChainID: "8453", Client: readerFake{}, Config: atomicQuoteConfig(middle)}
	handler := Handler{Chains: map[string]Chain{"a": chain}, QuoteConcurrency: 1}
	tests := []struct {
		name string
		edit func(*atomicv1.PlanQuoteRequest)
	}{
		{"missing version", func(r *atomicv1.PlanQuoteRequest) { r.FormatVersion = nil }},
		{"unknown version", func(r *atomicv1.PlanQuoteRequest) { r.FormatVersion = proto.Uint32(2) }},
		{"empty chain", func(r *atomicv1.PlanQuoteRequest) { r.ChainId = nil }},
		{"zero chain", func(r *atomicv1.PlanQuoteRequest) { r.ChainId = make([]byte, 32) }},
		{"short token", func(r *atomicv1.PlanQuoteRequest) { r.TokenIn = make([]byte, 19) }},
		{"equal token", func(r *atomicv1.PlanQuoteRequest) { r.TokenOut = append([]byte(nil), r.TokenIn...) }},
		{"zero amount", func(r *atomicv1.PlanQuoteRequest) { r.AmountIn = make([]byte, 32) }},
		{"missing budget", func(r *atomicv1.PlanQuoteRequest) { r.SearchBudgetMs = nil }},
		{"zero budget", func(r *atomicv1.PlanQuoteRequest) { r.SearchBudgetMs = proto.Uint32(0) }},
		{"unknown field", func(r *atomicv1.PlanQuoteRequest) { r.ProtoReflect().SetUnknown([]byte{0x38, 0x01}) }},
		{"unknown chain", func(r *atomicv1.PlanQuoteRequest) { r.ChainId = uint256Bytes(big.NewInt(1)) }},
		{"unconfigured token", func(r *atomicv1.PlanQuoteRequest) { r.TokenIn = common.HexToAddress("0x9999").Bytes() }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := atomicQuoteRequest("8453", testWETH, testUSDC, "37")
			test.edit(request)
			_, err := handler.GetPlanQuote(context.Background(), connect.NewRequest(request))
			var connectErr *connect.Error
			if !errors.As(err, &connectErr) || connectErr.Code() != connect.CodeInvalidArgument {
				t.Fatalf("got %v", err)
			}
		})
	}
	handler.Chains["b"] = chain
	_, err := handler.GetPlanQuote(context.Background(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) || connectErr.Code() != connect.CodeInvalidArgument {
		t.Fatalf("ambiguous chain got %v", err)
	}
}

func TestAtomicPlanQuoteAllowsEmptyAndPartialResults(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	config := atomicQuoteConfig(middle)
	for _, partial := range []bool{false, true} {
		reader := readerFake{
			snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
			call: func(ctx context.Context, _ common.Address, _ []byte, _ common.Hash) ([]byte, error) {
				if partial {
					<-ctx.Done()
					return nil, ctx.Err()
				}
				return make([]byte, 32), nil
			},
		}
		request := atomicQuoteRequest("8453", testWETH, testUSDC, "37")
		if partial {
			request.SearchBudgetMs = proto.Uint32(1)
		}
		response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: config}}, QuoteConcurrency: 2}).GetPlanQuote(context.Background(), connect.NewRequest(request))
		if err != nil || len(response.Msg.Candidates) != 0 || response.Msg.SearchComplete == nil || response.Msg.GetSearchComplete() == partial {
			t.Fatalf("partial=%t response=%+v error=%v", partial, response, err)
		}
	}
}
