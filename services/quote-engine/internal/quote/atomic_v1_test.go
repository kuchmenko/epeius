package quote

import (
	"context"
	"encoding/json"
	"math/big"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

type atomicSplitRequoter struct{ calls *[]string }

func (q atomicSplitRequoter) Requote(_ context.Context, route *quotev1.RouteQuote, amount *big.Int, block *quotev1.BlockContext) (*quotev1.RouteQuote, error) {
	*q.calls = append(*q.calls, amount.String())
	result := proto.CloneOf(route)
	result.Block = proto.CloneOf(block)
	result.AmountOutAtomic = map[string]string{"13": "29", "24": "53"}[amount.String()]
	return result, nil
}

func TestAtomicV1PublishedCommitmentVector(t *testing.T) {
	operation := atomicV1Operation{
		Kind:        1,
		TokenOut:    common.HexToAddress("0x0000000000000000000000000000000000000022"),
		Fee:         big.NewInt(500),
		TickSpacing: new(big.Int),
	}
	plan := atomicV1ExecutorPlan{
		TokenIn: common.HexToAddress("0x0000000000000000000000000000000000000011"), TokenOut: operation.TokenOut,
		AmountIn: big.NewInt(37), MinAmountOut: big.NewInt(11), Deadline: big.NewInt(2000000000),
		Branches: []atomicV1Branch{{AmountIn: big.NewInt(37), MinAmountOut: big.NewInt(11), Operations: []atomicV1Operation{operation}}},
	}
	actual, err := atomicV1ExecutorPlanHash(
		"8453",
		common.HexToAddress("0x0000000000000000000000000000000000000044"),
		common.HexToAddress("0x0000000000000000000000000000000000000055"),
		plan,
	)
	if err != nil || actual.Hex() != "0x69c0ba7621841b73782fbd11f817d4b8fca74f7f5a24be110fdde434d174a6f5" {
		t.Fatalf("commitment mismatch: %s %v", actual.Hex(), err)
	}
}

func TestAtomicV1BuildsExactOnePoolPlan(t *testing.T) {
	strategy := atomicV1Preparation{chain: Chain{ChainID: "8453", Config: config.Chain{
		AtomicExecutor: &config.AtomicExecutor{Address: "0x0000000000000000000000000000000000000044", RuntimeCodeHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", UniswapDeployment: "uni"},
		Deployments:    map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: "0x4444444444444444444444444444444444444444", Router: "0x5555555555555555555555555555555555555555"}},
	}}}
	route := &quotev1.RouteQuote{
		RouteId: "uni:500", Provider: "uniswap-v3", DeploymentId: "uni", AmountOutAtomic: "347415981",
		Block: &quotev1.BlockContext{Number: "12345678", Hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		Legs:  []*quotev1.RouteLeg{{Pool: "0x3333333333333333333333333333333333333333", TokenIn: "0x0000000000000000000000000000000000000011", TokenOut: "0x0000000000000000000000000000000000000022", Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}}},
	}
	p := &quotev1.PrepareExecutionResponse{
		Recipient: "0x0000000000000000000000000000000000000055", TokenIn: route.Legs[0].TokenIn, TokenOut: route.Legs[0].TokenOut,
		AmountInAtomic: "37", AmountOutMinimumAtomic: "11", ExpiresAtUnix: "1999999900", DeadlineUnix: "2000000000", Route: route,
	}
	plan, message := strategy.Build(p, 50)
	if message != "" || plan.atomicPlan == nil || plan.atomicPlan.ExecutorPlanHash != "0x69c0ba7621841b73782fbd11f817d4b8fca74f7f5a24be110fdde434d174a6f5" {
		t.Fatalf("plan mismatch: %s %+v", message, plan.atomicPlan)
	}
	var fixture struct {
		Calldata               string
		PlanID                 string
		TransactionFingerprint string
	}
	raw, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-plan.json")
	if err != nil || json.Unmarshal(raw, &fixture) != nil {
		t.Fatal("could not read Atomic V1 fixture")
	}
	if plan.transaction == nil || plan.transaction.To != "0x0000000000000000000000000000000000000044" || plan.transaction.Data != fixture.Calldata || hexutil.Encode(plan.atomicPlan.PlanId) != fixture.PlanID || hexutil.Encode(plan.atomicPlan.TransactionFingerprint) != fixture.TransactionFingerprint || plan.atomicPlan.AcceptedTerms == nil || len(plan.checks.ClearAllowances) != 1 {
		t.Fatalf("execution plan incomplete: %+v plan=%s fingerprint=%s", plan, hexutil.Encode(plan.atomicPlan.PlanId), hexutil.Encode(plan.atomicPlan.TransactionFingerprint))
	}
}

func TestAtomicV1BuildsIndependentTwoHopVector(t *testing.T) {
	var fixture struct {
		ChainID, Executor, Sender, RuntimeCodeHash, Factory, Router, TokenIn, IntermediateToken, TokenOut     string
		AmountInAtomic, AmountOutMinimumAtomic, DeadlineUnix, ExpiresAtUnix, QuoteBlockNumber, QuoteBlockHash string
		Pools                                                                                                 []string
		Calldata, ExecutorPlanHash, PlanID, TransactionFingerprint                                            string
	}
	raw, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-two-hop-plan.json")
	if err != nil || json.Unmarshal(raw, &fixture) != nil {
		t.Fatal("could not read two-hop Atomic V1 fixture")
	}
	strategy := atomicV1Preparation{chain: Chain{ChainID: fixture.ChainID, Config: config.Chain{
		AtomicExecutor: &config.AtomicExecutor{Address: fixture.Executor, RuntimeCodeHash: fixture.RuntimeCodeHash, UniswapDeployment: "uni"},
		Deployments:    map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: fixture.Factory, Router: fixture.Router}},
	}}}
	route := &quotev1.RouteQuote{
		RouteId: "uni:500:3000", Provider: "uniswap-v3", DeploymentId: "uni", AmountOutAtomic: "12",
		Block: &quotev1.BlockContext{Number: fixture.QuoteBlockNumber, Hash: fixture.QuoteBlockHash},
		Legs: []*quotev1.RouteLeg{
			{Pool: fixture.Pools[0], TokenIn: fixture.TokenIn, TokenOut: fixture.IntermediateToken, Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}},
			{Pool: fixture.Pools[1], TokenIn: fixture.IntermediateToken, TokenOut: fixture.TokenOut, Selector: &quotev1.RouteLeg_FeePips{FeePips: 3000}},
		},
	}
	p := &quotev1.PrepareExecutionResponse{
		Recipient: fixture.Sender, TokenIn: fixture.TokenIn, TokenOut: fixture.TokenOut, AmountInAtomic: fixture.AmountInAtomic,
		AmountOutMinimumAtomic: fixture.AmountOutMinimumAtomic, ExpiresAtUnix: fixture.ExpiresAtUnix, DeadlineUnix: fixture.DeadlineUnix, Route: route,
	}
	plan, message := strategy.Build(p, 50)
	if message != "" || plan.atomicPlan == nil || plan.transaction == nil {
		t.Fatalf("two-hop build failed: %s", message)
	}
	if plan.transaction.Data != fixture.Calldata || plan.atomicPlan.ExecutorPlanHash != fixture.ExecutorPlanHash || hexutil.Encode(plan.atomicPlan.PlanId) != fixture.PlanID || hexutil.Encode(plan.atomicPlan.TransactionFingerprint) != fixture.TransactionFingerprint {
		t.Fatalf("two-hop vector mismatch: plan=%+v transaction=%+v", plan.atomicPlan, plan.transaction)
	}
	if len(plan.atomicPlan.Branches) != 1 || len(plan.atomicPlan.Branches[0].Operations) != 2 || len(plan.atomicPlan.AcceptedTerms.GetProgram().GetBranches()[0].GetOperations()) != 2 || len(plan.checks.ClearAllowances) != 2 || len(plan.checks.Preserve) != 6 {
		t.Fatalf("two-hop obligations incomplete: %+v", plan)
	}
	saved := storedQuote{request: &quotev1.QuoteRequest{TokenIn: fixture.TokenIn, TokenOut: fixture.TokenOut}}
	if _, message := strategy.Select(t.Context(), saved, nil, route); message != "" {
		t.Fatalf("valid returned two-hop route rejected: %s", message)
	}

	for name, mutate := range map[string]func(*quotev1.RouteQuote){
		"broken continuity": func(value *quotev1.RouteQuote) { value.Legs[1].TokenIn = fixture.TokenIn },
		"repeated pool":     func(value *quotev1.RouteQuote) { value.Legs[1].Pool = value.Legs[0].Pool },
		"reverse pool": func(value *quotev1.RouteQuote) {
			value.Legs[1].Pool = value.Legs[0].Pool
			value.Legs[1].TokenOut = fixture.TokenIn
		},
	} {
		changed := proto.CloneOf(route)
		mutate(changed)
		if _, message := strategy.Select(t.Context(), saved, nil, changed); message == "" {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestAtomicV1BuildsIndependentSplitVectorAndBindsBranchOrder(t *testing.T) {
	var fixture struct {
		ChainID, Executor, Sender, RuntimeCodeHash, Factory, Router, TokenIn, TokenOut                        string
		AmountInAtomic, AmountOutMinimumAtomic, DeadlineUnix, ExpiresAtUnix, QuoteBlockNumber, QuoteBlockHash string
		Pools                                                                                                 []string
		Calldata, ExecutorPlanHash, PlanID, TransactionFingerprint                                            string
		BranchHashes                                                                                          []string
	}
	raw, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-split-plan.json")
	if err != nil || json.Unmarshal(raw, &fixture) != nil {
		t.Fatal("could not read split Atomic V1 fixture")
	}
	routes := []*quotev1.RouteQuote{
		{RouteId: "uni:500:first", Provider: "uniswap-v3", DeploymentId: "uni", Block: &quotev1.BlockContext{Number: fixture.QuoteBlockNumber, Hash: fixture.QuoteBlockHash}, Legs: []*quotev1.RouteLeg{{Pool: fixture.Pools[0], TokenIn: fixture.TokenIn, TokenOut: fixture.TokenOut, Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}}}},
		{RouteId: "uni:3000:second", Provider: "uniswap-v3", DeploymentId: "uni", Block: &quotev1.BlockContext{Number: fixture.QuoteBlockNumber, Hash: fixture.QuoteBlockHash}, Legs: []*quotev1.RouteLeg{{Pool: fixture.Pools[1], TokenIn: fixture.TokenIn, TokenOut: fixture.TokenOut, Selector: &quotev1.RouteLeg_FeePips{FeePips: 3000}}}},
	}
	calls := []string{}
	strategy := atomicV1Preparation{chain: Chain{ChainID: fixture.ChainID, Config: config.Chain{
		AtomicExecutor: &config.AtomicExecutor{Address: fixture.Executor, RuntimeCodeHash: fixture.RuntimeCodeHash, UniswapDeployment: "uni"},
		Deployments:    map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: fixture.Factory, Router: fixture.Router}},
	}, AllocationRequoters: map[string]allocationRequoter{"uni": atomicSplitRequoter{calls: &calls}}}}
	saved := storedQuote{
		request: &quotev1.QuoteRequest{TokenIn: fixture.TokenIn, TokenOut: fixture.TokenOut, AmountInAtomic: fixture.AmountInAtomic},
		final:   &quotev1.QuoteFinal{Routes: routes, Block: routes[0].Block},
	}
	request := &quotev1.PrepareExecutionRequest{Allocations: []*quotev1.RouteAllocation{{RouteId: routes[0].RouteId, AmountInAtomic: "13"}, {RouteId: routes[1].RouteId, AmountInAtomic: "24"}}}
	selection, message := strategy.Select(t.Context(), saved, request, nil)
	if message != "" || selection.output.String() != "82" || len(selection.allocations) != 2 || len(calls) != 2 {
		t.Fatalf("split selection failed: %s %+v %v", message, selection, calls)
	}
	p := &quotev1.PrepareExecutionResponse{
		Recipient: fixture.Sender, TokenIn: fixture.TokenIn, TokenOut: fixture.TokenOut, AmountInAtomic: fixture.AmountInAtomic,
		AmountOutMinimumAtomic: fixture.AmountOutMinimumAtomic, ExpiresAtUnix: fixture.ExpiresAtUnix, DeadlineUnix: fixture.DeadlineUnix, Allocations: selection.allocations,
	}
	plan, message := strategy.Build(p, 50)
	if message != "" || plan.atomicPlan == nil || plan.transaction == nil {
		t.Fatalf("split build failed: %s", message)
	}
	if plan.transaction.Data != fixture.Calldata || plan.atomicPlan.ExecutorPlanHash != fixture.ExecutorPlanHash || hexutil.Encode(plan.atomicPlan.PlanId) != fixture.PlanID || hexutil.Encode(plan.atomicPlan.TransactionFingerprint) != fixture.TransactionFingerprint {
		t.Fatalf("split vector mismatch: plan=%+v transaction=%+v", plan.atomicPlan, plan.transaction)
	}
	if len(plan.atomicPlan.Branches) != 2 || plan.atomicPlan.Branches[0].AmountOutMinimumAtomic != "28" || plan.atomicPlan.Branches[1].AmountOutMinimumAtomic != "52" || len(plan.atomicPlan.AcceptedTerms.GetProgram().GetBranches()) != 2 || len(plan.checks.ClearAllowances) != 2 {
		t.Fatalf("split obligations incomplete: %+v", plan)
	}
	branchMinimumTotal := new(big.Int)
	for _, branch := range plan.atomicPlan.Branches {
		value, _ := new(big.Int).SetString(branch.AmountOutMinimumAtomic, 10)
		branchMinimumTotal.Add(branchMinimumTotal, value)
	}
	if branchMinimumTotal.String() != "80" || p.AmountOutMinimumAtomic != "81" {
		t.Fatal("aggregate minimum was replaced by branch minimum sum")
	}

	reorderedRequest := &quotev1.PrepareExecutionRequest{Allocations: []*quotev1.RouteAllocation{{RouteId: routes[1].RouteId, AmountInAtomic: "24"}, {RouteId: routes[0].RouteId, AmountInAtomic: "13"}}}
	reorderedSelection, message := strategy.Select(t.Context(), saved, reorderedRequest, nil)
	if message != "" {
		t.Fatal(message)
	}
	reordered := proto.CloneOf(p)
	reordered.Allocations = reorderedSelection.allocations
	reorderedPlan, message := strategy.Build(reordered, 50)
	if message != "" || reorderedPlan.transaction.Data == plan.transaction.Data || reorderedPlan.atomicPlan.ExecutorPlanHash == plan.atomicPlan.ExecutorPlanHash || string(reorderedPlan.atomicPlan.PlanId) == string(plan.atomicPlan.PlanId) || string(reorderedPlan.atomicPlan.TransactionFingerprint) == string(plan.atomicPlan.TransactionFingerprint) {
		t.Fatal("branch reorder did not change every ordered identity")
	}

	calls = nil
	duplicateFee := proto.CloneOf(request)
	routes[1].Legs[0].Selector = &quotev1.RouteLeg_FeePips{FeePips: 500}
	if _, message := strategy.Select(t.Context(), saved, duplicateFee, nil); message == "" || len(calls) != 0 {
		t.Fatal("duplicate physical pool reached requote", message, calls)
	}
}

func TestAtomicV1RejectsUnsupportedUniswapRoute(t *testing.T) {
	strategy := atomicV1Preparation{chain: Chain{Config: config.Chain{AtomicExecutor: &config.AtomicExecutor{UniswapDeployment: "uni"}}}}
	saved := storedQuote{request: &quotev1.QuoteRequest{TokenIn: tokenA, TokenOut: tokenC}}
	for _, route := range []*quotev1.RouteQuote{
		nil,
		{Provider: "pancake-v3", DeploymentId: "uni", Legs: []*quotev1.RouteLeg{{}}},
		{Provider: "uniswap-v3", DeploymentId: "other", Legs: []*quotev1.RouteLeg{{}}},
		{Provider: "uniswap-v3", DeploymentId: "uni", Legs: []*quotev1.RouteLeg{{}, {}, {}}},
		{Provider: "uniswap-v3", DeploymentId: "uni", Legs: []*quotev1.RouteLeg{nil}},
	} {
		if _, message := strategy.Select(t.Context(), saved, nil, route); message == "" {
			t.Fatalf("accepted route: %+v", route)
		}
	}
}

func TestPrepareAtomicV1RunsVerificationAndSimulation(t *testing.T) {
	const executor = "0x1111111111111111111111111111111111111111"
	const factory = "0x4444444444444444444444444444444444444444"
	const router = "0x5555555555555555555555555555555555555555"
	const pool = "0x3333333333333333333333333333333333333333"
	const pool2 = "0x6666666666666666666666666666666666666666"
	const sender = "0x2222222222222222222222222222222222222222"
	intermediate := common.HexToAddress("0x7777777777777777777777777777777777777777")
	route := &quotev1.RouteQuote{
		RouteId: "uni:500", Provider: "uniswap-v3", DeploymentId: "uni", AmountOutAtomic: "347415981",
		Block: &quotev1.BlockContext{Number: "12345677", Hash: blockHash},
		Legs: []*quotev1.RouteLeg{
			{Pool: pool, TokenIn: testWETH.Hex(), TokenOut: intermediate.Hex(), Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}},
			{Pool: pool2, TokenIn: intermediate.Hex(), TokenOut: testUSDC.Hex(), Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}},
		},
	}
	chainConfig := config.Chain{
		ExecutionEnabled: true,
		Tokens:           []config.Token{{Address: testWETH.Hex()}, {Address: intermediate.Hex()}, {Address: testUSDC.Hex()}},
		AtomicExecutor:   &config.AtomicExecutor{Address: executor, RuntimeCodeHash: crypto.Keccak256Hash([]byte{1}).Hex(), UniswapDeployment: "uni"},
		Deployments:      map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: factory, Router: router, Fees: []uint32{500}}},
	}
	poolCalls := 0
	reader := executorReader{executionFake{readerFake: readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) {
			return rpc.Snapshot{ChainID: "8453", BlockNumber: "12345678", BlockHash: blockHash, Timestamp: 1999999880}, nil
		},
		call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
			if hash != common.HexToHash(blockHash) {
				t.Fatal("read escaped execution block")
			}
			switch hexutil.Encode(data[:4]) {
			case hexutil.Encode(contractabi.ExecutorV2.Methods["uniswapRouter"].ID):
				return common.LeftPadBytes(common.HexToAddress(router).Bytes(), 32), nil
			case hexutil.Encode(contractabi.ExecutorV2.Methods["pancakeRouter"].ID):
				return make([]byte, 32), nil
			case hexutil.Encode(contractabi.ExecutorV2.Methods["slipstreamRouter"].ID):
				return make([]byte, 32), nil
			case hexutil.Encode(contractabi.ExecutorV2.Methods["balancerVault"].ID):
				return make([]byte, 32), nil
			case hexutil.Encode(contractabi.ExecutorV2.Methods["universalRouter"].ID),
				hexutil.Encode(contractabi.ExecutorV2.Methods["permit2"].ID),
				hexutil.Encode(contractabi.ExecutorV2.Methods["poolManager"].ID):
				return make([]byte, 32), nil
			case hexutil.Encode(contractabi.ExecutorV2.Methods["version"].ID):
				return uintWord(2), nil
			case "0x1698ee82":
				poolCalls++
				selected := pool
				if poolCalls%2 == 0 {
					selected = pool2
				}
				return common.LeftPadBytes(common.HexToAddress(selected).Bytes(), 32), nil
			case "0xdd62ed3e":
				return uintWord(123456789012345678), nil
			default:
				t.Fatalf("unexpected call to %s with %s", to.Hex(), hexutil.Encode(data[:4]))
				return nil, nil
			}
		},
	}, canonical: func(context.Context, rpc.Snapshot) error { return nil }}}
	store := NewStore()
	request := &quotev1.QuoteRequest{Chain: "base", ChainId: "8453", TokenIn: testWETH.Hex(), TokenOut: testUSDC.Hex(), AmountInAtomic: "123456789012345678"}
	store.saveQuote(request, &quotev1.QuoteFinal{QuoteId: "quote", Block: route.Block, Routes: []*quotev1.RouteQuote{route}}, time.Now())
	simulated := false
	handler := Handler{
		Store:  store,
		Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: chainConfig, AtomicPreparer: atomicV1Preparation{chain: Chain{ChainID: "8453", Client: reader, Config: chainConfig}}}},
		Simulator: simulationFake(func(_ context.Context, tx *quotev1.UnsignedTransaction, checks SimulationChecks, _ rpc.Snapshot, amount, minimum *big.Int) (string, error) {
			simulated = true
			if tx.To != executor || amount.String() != "123456789012345678" || minimum.String() != "345678901" || len(checks.ClearAllowances) != 2 || len(checks.Preserve) != 6 {
				t.Fatal("wrong simulation terms")
			}
			return "347415980", nil
		}),
	}
	response, err := handler.PrepareExecution(t.Context(), connect.NewRequest(&quotev1.PrepareExecutionRequest{
		QuoteId: "quote", RouteId: route.RouteId, Sender: sender, SlippageBps: 50, ExecutionMode: quotev1.ExecutionMode_EXECUTION_MODE_ATOMIC_V1,
	}))
	if err != nil || response.Msg.Status != quotev1.PreparationStatus_PREPARATION_STATUS_READY || response.Msg.AtomicPlan == nil || response.Msg.Transaction == nil || !simulated {
		t.Fatalf("Atomic V1 preparation failed: %+v %v", response, err)
	}
	rechecked, err := handler.PrepareExecution(t.Context(), connect.NewRequest(&quotev1.PrepareExecutionRequest{PreparationId: response.Msg.PreparationId}))
	if err != nil || !proto.Equal(response.Msg.AtomicPlan, rechecked.Msg.AtomicPlan) || !proto.Equal(response.Msg.Transaction, rechecked.Msg.Transaction) {
		t.Fatalf("Atomic V1 recheck changed frozen identities or transaction: %+v %v", rechecked, err)
	}
	wrongRuntime := chainConfig
	wrongRuntime.AtomicExecutor = &config.AtomicExecutor{
		Address: executor, RuntimeCodeHash: common.HexToHash("0xbb").Hex(), UniswapDeployment: "uni",
	}
	if err := verifyAtomicV1Executor(t.Context(), reader, wrongRuntime, route, common.HexToHash(blockHash)); err == nil {
		t.Fatal("executor runtime hash mismatch accepted")
	}
}
