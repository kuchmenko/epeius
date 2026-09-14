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
)

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
		AtomicExecutor: &config.AtomicExecutor{Address: "0x0000000000000000000000000000000000000044", RuntimeCodeHash: common.HexToHash("0xaa").Hex(), UniswapDeployment: "uni"},
		Deployments:    map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: "0x4444444444444444444444444444444444444444", Router: "0x5555555555555555555555555555555555555555"}},
	}}}
	route := &quotev1.RouteQuote{
		RouteId: "uni:500", Provider: "uniswap-v3", DeploymentId: "uni", AmountOutAtomic: "347415981",
		Legs: []*quotev1.RouteLeg{{Pool: "0x3333333333333333333333333333333333333333", TokenIn: "0x0000000000000000000000000000000000000011", TokenOut: "0x0000000000000000000000000000000000000022", Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}}},
	}
	p := &quotev1.PrepareExecutionResponse{
		Recipient: "0x0000000000000000000000000000000000000055", TokenIn: route.Legs[0].TokenIn, TokenOut: route.Legs[0].TokenOut,
		AmountInAtomic: "37", AmountOutMinimumAtomic: "11", DeadlineUnix: "2000000000", Route: route,
	}
	plan, message := strategy.Build(p)
	if message != "" || plan.atomicPlan == nil || plan.atomicPlan.ExecutorPlanHash != "0x69c0ba7621841b73782fbd11f817d4b8fca74f7f5a24be110fdde434d174a6f5" {
		t.Fatalf("plan mismatch: %s %+v", message, plan.atomicPlan)
	}
	var fixture struct{ Calldata string }
	raw, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-plan.json")
	if err != nil || json.Unmarshal(raw, &fixture) != nil {
		t.Fatal("could not read Atomic V1 fixture")
	}
	if plan.transaction == nil || plan.transaction.To != "0x0000000000000000000000000000000000000044" || plan.transaction.Data != fixture.Calldata || len(plan.checks.ClearAllowances) != 1 {
		t.Fatalf("execution plan incomplete: %+v", plan)
	}
}

func TestAtomicV1RejectsNonSingleUniswapRoute(t *testing.T) {
	strategy := atomicV1Preparation{chain: Chain{Config: config.Chain{AtomicExecutor: &config.AtomicExecutor{UniswapDeployment: "uni"}}}}
	saved := storedQuote{request: &quotev1.QuoteRequest{TokenIn: tokenA, TokenOut: tokenC}}
	for _, route := range []*quotev1.RouteQuote{
		nil,
		{Provider: "pancake-v3", DeploymentId: "uni", Legs: []*quotev1.RouteLeg{{}}},
		{Provider: "uniswap-v3", DeploymentId: "other", Legs: []*quotev1.RouteLeg{{}}},
		{Provider: "uniswap-v3", DeploymentId: "uni", Legs: []*quotev1.RouteLeg{{}, {}}},
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
	const sender = "0x2222222222222222222222222222222222222222"
	route := &quotev1.RouteQuote{
		RouteId: "uni:500", Provider: "uniswap-v3", DeploymentId: "uni", AmountOutAtomic: "347415981",
		Block: &quotev1.BlockContext{Number: "12345677", Hash: blockHash},
		Legs:  []*quotev1.RouteLeg{{Pool: pool, TokenIn: testWETH.Hex(), TokenOut: testUSDC.Hex(), Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}}},
	}
	chainConfig := config.Chain{
		ExecutionEnabled: true,
		Tokens:           []config.Token{{Address: testWETH.Hex()}, {Address: testUSDC.Hex()}},
		AtomicExecutor:   &config.AtomicExecutor{Address: executor, RuntimeCodeHash: crypto.Keccak256Hash([]byte{1}).Hex(), UniswapDeployment: "uni"},
		Deployments:      map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: factory, Router: router, Fees: []uint32{500}}},
	}
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
			case hexutil.Encode(contractabi.ExecutorV2.Methods["version"].ID):
				return uintWord(2), nil
			case "0x1698ee82":
				return common.LeftPadBytes(common.HexToAddress(pool).Bytes(), 32), nil
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
			if tx.To != executor || amount.String() != "123456789012345678" || minimum.String() != "345678901" || len(checks.ClearAllowances) != 1 {
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
	wrongRuntime := chainConfig
	wrongRuntime.AtomicExecutor = &config.AtomicExecutor{
		Address: executor, RuntimeCodeHash: common.HexToHash("0xbb").Hex(), UniswapDeployment: "uni",
	}
	if err := verifyAtomicV1Executor(t.Context(), reader, wrongRuntime, route, common.HexToHash(blockHash)); err == nil {
		t.Fatal("executor runtime hash mismatch accepted")
	}
}
