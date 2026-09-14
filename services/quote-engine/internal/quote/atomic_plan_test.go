package quote

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

type atomicPlanReader struct {
	config    config.Chain
	program   *atomicv1.PlanProgram
	runtime   []byte
	allowance *big.Int
	discount  *big.Int
	snapshots []rpc.Snapshot
	canonical int
}

func (r *atomicPlanReader) Snapshot(context.Context) (rpc.Snapshot, error) {
	if len(r.snapshots) == 0 {
		return rpc.Snapshot{}, errors.New("missing snapshot")
	}
	value := r.snapshots[0]
	if len(r.snapshots) > 1 {
		r.snapshots = r.snapshots[1:]
	}
	return value, nil
}

func (r *atomicPlanReader) Canonical(context.Context, rpc.Snapshot) error {
	r.canonical++
	return nil
}

func (r *atomicPlanReader) Code(context.Context, common.Address, common.Hash) ([]byte, error) {
	return append([]byte(nil), r.runtime...), nil
}

func (r *atomicPlanReader) Call(_ context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
	executor := common.HexToAddress(r.config.AtomicExecutor.Address)
	uniswap := r.config.Deployments[r.config.AtomicExecutor.UniswapDeployment]
	pancake := r.config.Deployments[r.config.AtomicExecutor.PancakeDeployment]
	slipstream := r.config.Deployments[r.config.AtomicExecutor.SlipstreamDeployment]
	feeModule := common.HexToAddress("0xdddddddddddddddddddddddddddddddddddddddd")
	if to == executor && bytes.Equal(data[:4], contractabi.ExecutorV2.Methods["uniswapRouter"].ID) {
		return contractabi.ExecutorV2.Methods["uniswapRouter"].Outputs.Pack(common.HexToAddress(uniswap.Router))
	}
	if to == executor && bytes.Equal(data[:4], contractabi.ExecutorV2.Methods["pancakeRouter"].ID) {
		return contractabi.ExecutorV2.Methods["pancakeRouter"].Outputs.Pack(common.HexToAddress(pancake.Router))
	}
	if to == executor && bytes.Equal(data[:4], contractabi.ExecutorV2.Methods["slipstreamRouter"].ID) {
		return contractabi.ExecutorV2.Methods["slipstreamRouter"].Outputs.Pack(common.HexToAddress(slipstream.Router))
	}
	if to == executor && bytes.Equal(data[:4], contractabi.ExecutorV2.Methods["version"].ID) {
		return contractabi.ExecutorV2.Methods["version"].Outputs.Pack(big.NewInt(2))
	}
	if (to == common.HexToAddress(uniswap.Factory) || to == common.HexToAddress(pancake.Factory)) && bytes.Equal(data[:4], contractabi.UniswapV3Factory.Methods["getPool"].ID) {
		values, _ := contractabi.UniswapV3Factory.Methods["getPool"].Inputs.Unpack(data[4:])
		for _, operation := range r.program.Branches[0].Operations {
			pool, _ := atomicV3Pool(operation)
			if values[0].(common.Address) == common.BytesToAddress(operation.TokenIn) && values[1].(common.Address) == common.BytesToAddress(operation.TokenOut) && values[2].(*big.Int).Uint64() == uint64(pool.GetFeePips()) {
				return contractabi.UniswapV3Factory.Methods["getPool"].Outputs.Pack(common.BytesToAddress(pool.Pool))
			}
		}
	}
	if to == common.HexToAddress(slipstream.Factory) && bytes.Equal(data[:4], contractabi.AerodromeSlipstreamFactory.Methods["getPool"].ID) {
		values, _ := contractabi.AerodromeSlipstreamFactory.Methods["getPool"].Inputs.Unpack(data[4:])
		for _, operation := range r.program.Branches[0].Operations {
			pool := operation.GetSlipstreamInitial()
			if pool != nil && values[0].(common.Address) == common.BytesToAddress(operation.TokenIn) && values[1].(common.Address) == common.BytesToAddress(operation.TokenOut) && values[2].(*big.Int).Int64() == int64(pool.GetTickSpacing()) {
				return contractabi.AerodromeSlipstreamFactory.Methods["getPool"].Outputs.Pack(common.BytesToAddress(pool.Pool))
			}
		}
	}
	if to == common.HexToAddress(slipstream.Factory) && bytes.Equal(data[:4], contractabi.AerodromeSlipstreamFactory.Methods["swapFeeModule"].ID) {
		return contractabi.AerodromeSlipstreamFactory.Methods["swapFeeModule"].Outputs.Pack(feeModule)
	}
	if to == feeModule && bytes.Equal(data[:4], contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["factory"].ID) {
		return contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["factory"].Outputs.Pack(common.HexToAddress(slipstream.Factory))
	}
	if to == feeModule && bytes.Equal(data[:4], contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["discounted"].ID) {
		discount := r.discount
		if discount == nil {
			discount = new(big.Int)
		}
		return contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["discounted"].Outputs.Pack(discount)
	}
	if to == common.BytesToAddress(r.program.TokenIn) && bytes.Equal(data[:4], erc20ABI.Methods["allowance"].ID) {
		return erc20ABI.Methods["allowance"].Outputs.Pack(r.allowance)
	}
	return nil, errors.New("unexpected call")
}

type atomicPlanSimulator struct {
	results []SimulationResult
	checks  []SimulationChecks
}

func (s *atomicPlanSimulator) Simulate(context.Context, *quotev1.UnsignedTransaction, SimulationChecks, rpc.Snapshot, *big.Int, *big.Int) (string, error) {
	return "", errors.New("legacy simulation not used")
}

func (s *atomicPlanSimulator) SimulateAtomic(_ context.Context, _ *quotev1.UnsignedTransaction, checks SimulationChecks, _ rpc.Snapshot, _, _ *big.Int) (SimulationResult, error) {
	s.checks = append(s.checks, checks.clone())
	if len(s.results) == 0 {
		return SimulationResult{}, errSimulationUnavailable
	}
	value := s.results[0]
	if len(s.results) > 1 {
		s.results = s.results[1:]
	}
	return value, nil
}

func atomicPlanTestData(t *testing.T) (Chain, *atomicv1.PlanCandidate, *atomicv1.AcceptedPlanTerms, common.Hash) {
	t.Helper()
	runtime := []byte{1, 2, 3, 4}
	factory := common.HexToAddress("0x4444444444444444444444444444444444444444")
	router := common.HexToAddress("0x5555555555555555555555555555555555555555")
	executor := common.HexToAddress("0x6666666666666666666666666666666666666666")
	signer := common.HexToAddress("0x7777777777777777777777777777777777777777")
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	out := common.HexToAddress("0x3333333333333333333333333333333333333333")
	in := common.HexToAddress("0x1111111111111111111111111111111111111111")
	fees := []uint32{500, 3000}
	pools := []common.Address{common.HexToAddress("0x8888888888888888888888888888888888888888"), common.HexToAddress("0x9999999999999999999999999999999999999999")}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(big.NewInt(12345678)), Hash: common.HexToHash("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").Bytes()}
	candidate, err := atomicPlanCandidate(big.NewInt(8453), big.NewInt(37), in, out, config.Deployment{Factory: factory.Hex(), Router: router.Hex()}, candidate{tokens: []common.Address{in, middle, out}, fees: fees}, block, []*big.Int{big.NewInt(91), big.NewInt(77)}, pools)
	if err != nil {
		t.Fatal(err)
	}
	chainConfig := config.Chain{
		ChainID: 8453, ExecutionEnabled: true, Tokens: []config.Token{{Address: in.Hex()}, {Address: middle.Hex()}, {Address: out.Hex()}},
		Deployments:    map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: factory.Hex(), Router: router.Hex(), Fees: fees}},
		AtomicExecutor: &config.AtomicExecutor{Address: executor.Hex(), RuntimeCodeHash: crypto.Keccak256Hash(runtime).Hex(), UniswapDeployment: "uni"},
	}
	now := time.Now().Unix()
	terms := &atomicv1.AcceptedPlanTerms{
		Program: proto.CloneOf(candidate.Program), Executor: &atomicv1.ExecutorIdentity{Address: executor.Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: crypto.Keccak256Hash(runtime).Bytes()},
		Signer: signer.Bytes(), Recipient: signer.Bytes(), BranchMinima: [][]byte{uint256Bytes(big.NewInt(60))}, AmountOutMinimum: uint256Bytes(big.NewInt(60)), QuoteBlock: proto.CloneOf(block), ExpiresAtUnix: uint256Bytes(big.NewInt(now + 20)), DeadlineUnix: uint256Bytes(big.NewInt(now + 25)),
	}
	planID, err := atomicV1PlanID(terms)
	if err != nil {
		t.Fatal(err)
	}
	return Chain{ChainID: "8453", Config: chainConfig}, candidate, terms, planID
}

func atomicPlanLogs(t *testing.T, executor common.Address, caller common.Address, planHash common.Hash, program *atomicv1.PlanProgram, outputs ...int64) []SimulationLog {
	t.Helper()
	logs := make([]SimulationLog, 0, len(outputs)+2)
	previous := new(big.Int).SetBytes(program.AmountIn)
	for i, output := range outputs {
		operation := program.Branches[0].Operations[i]
		pool, _ := atomicPool(operation)
		kind := pool.kind
		data, err := contractabi.ExecutorV2.Events["OperationExecuted"].Inputs.NonIndexed().Pack(kind, common.BytesToAddress(operation.TokenIn), common.BytesToAddress(operation.TokenOut), previous, big.NewInt(output))
		if err != nil {
			t.Fatal(err)
		}
		logs = append(logs, SimulationLog{Address: executor, Topics: []common.Hash{atomicOperationTopic, planHash, {}, common.BigToHash(big.NewInt(int64(i)))}, Data: data})
		previous = big.NewInt(output)
	}
	branchData, _ := contractabi.ExecutorV2.Events["BranchExecuted"].Inputs.NonIndexed().Pack(new(big.Int).SetBytes(program.AmountIn), previous)
	logs = append(logs, SimulationLog{Address: executor, Topics: []common.Hash{atomicBranchTopic, planHash, {}}, Data: branchData})
	planData, _ := contractabi.ExecutorV2.Events["PlanExecuted"].Inputs.NonIndexed().Pack(common.BytesToAddress(program.TokenIn), new(big.Int).SetBytes(program.AmountIn), previous)
	logs = append(logs, SimulationLog{Address: executor, Topics: []common.Hash{atomicPlanTopic, planHash, common.BytesToHash(common.LeftPadBytes(caller.Bytes(), 32)), common.BytesToHash(common.LeftPadBytes(program.TokenOut, 32))}, Data: planData})
	return logs
}

func withAtomicNativeRefund(t *testing.T, logs []SimulationLog, executor, caller common.Address, planHash common.Hash, amount int64) []SimulationLog {
	t.Helper()
	data, err := contractabi.ExecutorV2.Events["NativeRefunded"].Inputs.NonIndexed().Pack(big.NewInt(amount))
	if err != nil {
		t.Fatal(err)
	}
	refund := SimulationLog{Address: executor, Topics: []common.Hash{atomicNativeTopic, planHash, common.BytesToHash(common.LeftPadBytes(caller.Bytes(), 32))}, Data: data}
	return append(append(logs[:len(logs)-1:len(logs)-1], refund), logs[len(logs)-1])
}

func pancakeAtomicPlanTestData(t *testing.T) (Chain, *atomicv1.PlanCandidate, *atomicv1.AcceptedPlanTerms, common.Hash) {
	t.Helper()
	chain, candidate, terms, _ := atomicPlanTestData(t)
	factory := common.HexToAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	router := common.HexToAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	for _, operation := range candidate.Program.Branches[0].Operations {
		pool := operation.GetUniswapV3()
		pool.Factory, pool.Router = factory.Bytes(), router.Bytes()
		operation.Pool = &atomicv1.PoolOperation_PancakeV3{PancakeV3: pool}
	}
	candidateID, err := atomicCandidateHash(candidate.Program, candidate.QuoteBlock, candidate.BranchQuotes)
	if err != nil {
		t.Fatal(err)
	}
	candidate.CandidateId = candidateID.Bytes()
	terms.Program = proto.CloneOf(candidate.Program)
	chain.Config.Deployments = map[string]config.Deployment{"cake": {Kind: "pancake-v3", Factory: factory.Hex(), Router: router.Hex(), Fees: []uint32{500, 3000}}}
	chain.Config.AtomicExecutor.UniswapDeployment = ""
	chain.Config.AtomicExecutor.PancakeDeployment = "cake"
	planID, err := atomicV1PlanID(terms)
	if err != nil {
		t.Fatal(err)
	}
	return chain, candidate, terms, planID
}

func slipstreamAtomicPlanTestData(t *testing.T) (Chain, *atomicv1.PlanCandidate, *atomicv1.AcceptedPlanTerms, common.Hash) {
	t.Helper()
	chain, candidate, terms, _ := atomicPlanTestData(t)
	factory := common.HexToAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	router := common.HexToAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	spacings := []int32{100, 200}
	for i, operation := range candidate.Program.Branches[0].Operations {
		pool := operation.GetUniswapV3()
		operation.Pool = &atomicv1.PoolOperation_SlipstreamInitial{SlipstreamInitial: &atomicv1.SlipstreamPool{Factory: factory.Bytes(), Router: router.Bytes(), Pool: pool.Pool, TickSpacing: proto.Int32(spacings[i])}}
	}
	candidateID, err := atomicCandidateHash(candidate.Program, candidate.QuoteBlock, candidate.BranchQuotes)
	if err != nil {
		t.Fatal(err)
	}
	candidate.CandidateId = candidateID.Bytes()
	terms.Program = proto.CloneOf(candidate.Program)
	chain.Config.Deployments = map[string]config.Deployment{"slip": {Kind: "aerodrome-slipstream", Factory: factory.Hex(), Router: router.Hex()}}
	chain.Config.AtomicExecutor.UniswapDeployment = ""
	chain.Config.AtomicExecutor.SlipstreamDeployment = "slip"
	planID, err := atomicV1PlanID(terms)
	if err != nil {
		t.Fatal(err)
	}
	return chain, candidate, terms, planID
}

func TestPrepareSlipstreamAtomicPlanUsesKindThreeMeasuredEventsAndZeroDiscount(t *testing.T) {
	chain, candidate, terms, planID := slipstreamAtomicPlanTestData(t)
	reader := &atomicPlanReader{config: chain.Config, program: candidate.Program, runtime: []byte{1, 2, 3, 4}, allowance: big.NewInt(37), snapshots: []rpc.Snapshot{{ChainID: "8453", BlockNumber: "12345679", BlockHash: common.HexToHash("0xbb").Hex(), Timestamp: uint64(time.Now().Unix())}}}
	chain.Client = reader
	validated, err := validateAcceptedAtomicTerms(chain, terms, planID.Bytes(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	expectedPlan := atomicV1ExecutorPlan{
		TokenIn: common.BytesToAddress(candidate.Program.TokenIn), TokenOut: common.BytesToAddress(candidate.Program.TokenOut), AmountIn: big.NewInt(37), MinAmountOut: big.NewInt(60), Deadline: new(big.Int).SetBytes(terms.DeadlineUnix),
		Branches: []atomicV1Branch{{AmountIn: big.NewInt(37), MinAmountOut: big.NewInt(60), Operations: []atomicV1Operation{{Kind: 3, TokenOut: common.BytesToAddress(candidate.Program.Branches[0].Operations[0].TokenOut), Fee: new(big.Int), TickSpacing: big.NewInt(100)}, {Kind: 3, TokenOut: common.BytesToAddress(candidate.Program.Branches[0].Operations[1].TokenOut), Fee: new(big.Int), TickSpacing: big.NewInt(200)}}}},
	}
	expectedData, err := contractabi.ExecutorV2.Pack("execute", expectedPlan)
	if err != nil || validated.transaction.Data != hexutil.Encode(expectedData) {
		t.Fatal("Slipstream operation did not encode kind 3")
	}
	executor, signer := common.BytesToAddress(terms.Executor.Address), common.BytesToAddress(terms.Signer)
	store := NewStore()
	quoteID := bytes.Repeat([]byte{0x28}, 32)
	store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: quoteID, Candidates: []*atomicv1.PlanCandidate{candidate}, SearchComplete: proto.Bool(true)}, time.Now())
	logs := atomicPlanLogs(t, executor, signer, validated.executorPlanHash, candidate.Program, 83, 61)
	logs = withAtomicNativeRefund(t, logs, executor, signer, validated.executorPlanHash, 1)
	handler := Handler{Chains: map[string]Chain{"base": chain}, Store: store, Simulator: &atomicPlanSimulator{results: []SimulationResult{{Output: "61", Logs: logs}}}}
	response, err := handler.PreparePlan(t.Context(), connect.NewRequest(&atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}))
	if err != nil || response.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY || new(big.Int).SetBytes(response.Msg.Simulation.BranchResults[0].OperationOutputs[0]).Cmp(big.NewInt(83)) != 0 {
		t.Fatalf("Slipstream preparation failed: %+v %v", response, err)
	}

	reader.discount = big.NewInt(1)
	reader.snapshots = []rpc.Snapshot{{ChainID: "8453", BlockNumber: "12345680", BlockHash: common.HexToHash("0xcc").Hex(), Timestamp: uint64(time.Now().Unix())}}
	rejected, err := handler.PreparePlan(t.Context(), connect.NewRequest(&atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}))
	if err != nil || rejected.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED {
		t.Fatalf("discounted Slipstream signer was not rejected: %+v %v", rejected, err)
	}
}

func TestPreparePancakeAtomicPlanUsesKindTwoAndMeasuredEvents(t *testing.T) {
	chain, candidate, terms, planID := pancakeAtomicPlanTestData(t)
	reader := &atomicPlanReader{config: chain.Config, program: candidate.Program, runtime: []byte{1, 2, 3, 4}, allowance: big.NewInt(37), snapshots: []rpc.Snapshot{{ChainID: "8453", BlockNumber: "12345679", BlockHash: common.HexToHash("0xbb").Hex(), Timestamp: uint64(time.Now().Unix())}}}
	chain.Client = reader
	validated, err := validateAcceptedAtomicTerms(chain, terms, planID.Bytes(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if validated.executorPlanHash == (common.Hash{}) {
		t.Fatal("missing executor hash")
	}
	expectedPlan := atomicV1ExecutorPlan{
		TokenIn: common.BytesToAddress(candidate.Program.TokenIn), TokenOut: common.BytesToAddress(candidate.Program.TokenOut), AmountIn: big.NewInt(37), MinAmountOut: big.NewInt(60), Deadline: new(big.Int).SetBytes(terms.DeadlineUnix),
		Branches: []atomicV1Branch{{AmountIn: big.NewInt(37), MinAmountOut: big.NewInt(60), Operations: []atomicV1Operation{{Kind: 2, TokenOut: common.BytesToAddress(candidate.Program.Branches[0].Operations[0].TokenOut), Fee: big.NewInt(500), TickSpacing: new(big.Int)}, {Kind: 2, TokenOut: common.BytesToAddress(candidate.Program.Branches[0].Operations[1].TokenOut), Fee: big.NewInt(3000), TickSpacing: new(big.Int)}}}},
	}
	expectedData, err := contractabi.ExecutorV2.Pack("execute", expectedPlan)
	if err != nil || validated.transaction.Data != hexutil.Encode(expectedData) {
		t.Fatal("Pancake operation did not encode kind 2")
	}
	executor, signer := common.BytesToAddress(terms.Executor.Address), common.BytesToAddress(terms.Signer)
	store := NewStore()
	quoteID := bytes.Repeat([]byte{0x27}, 32)
	store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: quoteID, Candidates: []*atomicv1.PlanCandidate{candidate}, SearchComplete: proto.Bool(true)}, time.Now())
	handler := Handler{Chains: map[string]Chain{"base": chain}, Store: store, Simulator: &atomicPlanSimulator{results: []SimulationResult{{Output: "61", Logs: atomicPlanLogs(t, executor, signer, validated.executorPlanHash, candidate.Program, 83, 61)}}}}
	response, err := handler.PreparePlan(t.Context(), connect.NewRequest(&atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}))
	if err != nil || response.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY || new(big.Int).SetBytes(response.Msg.Simulation.BranchResults[0].OperationOutputs[0]).Cmp(big.NewInt(83)) != 0 {
		t.Fatalf("Pancake preparation failed: %+v %v", response, err)
	}
}

func TestPrepareAndRecheckAtomicPlanUseMeasuredEventsAndFrozenTransaction(t *testing.T) {
	chain, candidate, terms, planID := atomicPlanTestData(t)
	reader := &atomicPlanReader{config: chain.Config, program: candidate.Program, runtime: []byte{1, 2, 3, 4}, allowance: big.NewInt(37), snapshots: []rpc.Snapshot{{ChainID: "8453", BlockNumber: "12345679", BlockHash: common.HexToHash("0xbb").Hex(), Timestamp: uint64(time.Now().Unix())}, {ChainID: "8453", BlockNumber: "12345680", BlockHash: common.HexToHash("0xcc").Hex(), Timestamp: uint64(time.Now().Unix())}}}
	chain.Client = reader
	validated, err := validateAcceptedAtomicTerms(chain, terms, planID.Bytes(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	executor, signer := common.BytesToAddress(terms.Executor.Address), common.BytesToAddress(terms.Signer)
	simulator := &atomicPlanSimulator{results: []SimulationResult{
		{Output: "61", Logs: atomicPlanLogs(t, executor, signer, validated.executorPlanHash, candidate.Program, 83, 61)},
		{Output: "64", Logs: atomicPlanLogs(t, executor, signer, validated.executorPlanHash, candidate.Program, 84, 64)},
	}}
	store := NewStore()
	quoteID := bytes.Repeat([]byte{0x12}, 32)
	store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: quoteID, Candidates: []*atomicv1.PlanCandidate{candidate}, SearchComplete: proto.Bool(true)}, time.Now())
	handler := Handler{Chains: map[string]Chain{"base": chain}, Store: store, Simulator: simulator}
	prepared, err := handler.PreparePlan(t.Context(), connect.NewRequest(&atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}))
	if err != nil || prepared.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY {
		t.Fatalf("prepare failed: %+v %v", prepared, err)
	}
	if got := prepared.Msg.Simulation.BranchResults[0].OperationOutputs; new(big.Int).SetBytes(got[0]).Int64() != 83 || new(big.Int).SetBytes(got[1]).Int64() != 61 {
		t.Fatal("simulation copied quote outputs instead of measured events")
	}
	frozen := proto.CloneOf(prepared.Msg.Preparation)
	rechecked, err := handler.RecheckPlan(t.Context(), connect.NewRequest(&atomicv1.RecheckPlanRequest{PreparationId: frozen.PreparationId, PlanId: planID.Bytes()}))
	if err != nil || rechecked.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY || !proto.Equal(frozen, rechecked.Msg.Preparation) || new(big.Int).SetBytes(rechecked.Msg.Simulation.BranchResults[0].OperationOutputs[1]).Int64() != 64 || bytes.Equal(prepared.Msg.Simulation.Block.Number, rechecked.Msg.Simulation.Block.Number) {
		t.Fatalf("recheck failed or changed frozen terms: %+v %v", rechecked, err)
	}
	if reader.canonical != 3 || len(simulator.checks) != 2 || len(simulator.checks[0].ClearAllowances) != 2 {
		t.Fatalf("checks were not rerun: canonical=%d checks=%+v", reader.canonical, simulator.checks)
	}
}

func TestPrepareAtomicPlanPreservesDirectCandidate(t *testing.T) {
	chain, twoHop, terms, _ := atomicPlanTestData(t)
	candidate := proto.CloneOf(twoHop)
	operation := proto.CloneOf(candidate.Program.Branches[0].Operations[1])
	operation.TokenIn = append([]byte(nil), candidate.Program.TokenIn...)
	candidate.Program.Branches[0].Operations = []*atomicv1.PoolOperation{operation}
	candidate.BranchQuotes[0].OperationOutputs = [][]byte{uint256Bytes(big.NewInt(77))}
	candidateID, err := atomicCandidateHash(candidate.Program, candidate.QuoteBlock, candidate.BranchQuotes)
	if err != nil {
		t.Fatal(err)
	}
	candidate.CandidateId = candidateID.Bytes()
	terms.Program = proto.CloneOf(candidate.Program)
	planID, err := atomicV1PlanID(terms)
	if err != nil {
		t.Fatal(err)
	}
	reader := &atomicPlanReader{config: chain.Config, program: candidate.Program, runtime: []byte{1, 2, 3, 4}, allowance: big.NewInt(37), snapshots: []rpc.Snapshot{{ChainID: "8453", BlockNumber: "12345679", BlockHash: common.HexToHash("0xbb").Hex(), Timestamp: uint64(time.Now().Unix())}}}
	chain.Client = reader
	validated, err := validateAcceptedAtomicTerms(chain, terms, planID.Bytes(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	executor, signer := common.BytesToAddress(terms.Executor.Address), common.BytesToAddress(terms.Signer)
	store := NewStore()
	quoteID := bytes.Repeat([]byte{0x15}, 32)
	store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: quoteID, Candidates: []*atomicv1.PlanCandidate{candidate}, SearchComplete: proto.Bool(true)}, time.Now())
	handler := Handler{Chains: map[string]Chain{"base": chain}, Store: store, Simulator: &atomicPlanSimulator{results: []SimulationResult{{Output: "67", Logs: atomicPlanLogs(t, executor, signer, validated.executorPlanHash, candidate.Program, 67)}}}}
	response, err := handler.PreparePlan(t.Context(), connect.NewRequest(&atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}))
	if err != nil || response.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY || len(response.Msg.Simulation.BranchResults[0].OperationOutputs) != 1 || new(big.Int).SetBytes(response.Msg.Simulation.BranchResults[0].OperationOutputs[0]).Int64() != 67 {
		t.Fatalf("direct candidate preparation failed: %+v %v", response, err)
	}
}

func TestPrepareAtomicPlanRequiresFreshQuoteAfterFiniteApproval(t *testing.T) {
	chain, candidate, terms, planID := atomicPlanTestData(t)
	reader := &atomicPlanReader{config: chain.Config, program: candidate.Program, runtime: []byte{1, 2, 3, 4}, allowance: new(big.Int), snapshots: []rpc.Snapshot{{ChainID: "8453", BlockNumber: "12345679", BlockHash: common.HexToHash("0xbb").Hex(), Timestamp: uint64(time.Now().Unix())}}}
	chain.Client = reader
	store := NewStore()
	quoteID := bytes.Repeat([]byte{0x13}, 32)
	store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: quoteID, Candidates: []*atomicv1.PlanCandidate{candidate}, SearchComplete: proto.Bool(true)}, time.Now())
	handler := Handler{Chains: map[string]Chain{"base": chain}, Store: store, Simulator: &atomicPlanSimulator{}}
	request := &atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}
	response, err := handler.PreparePlan(t.Context(), connect.NewRequest(request))
	if err != nil || response.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_APPROVAL_REQUIRED || response.Msg.Preparation != nil || response.Msg.Simulation != nil || response.Msg.Approval == nil || !bytes.Equal(response.Msg.Approval.Amount, candidate.Program.AmountIn) {
		t.Fatalf("approval response invalid: %+v %v", response, err)
	}
	values, err := erc20ABI.Methods["approve"].Inputs.Unpack(response.Msg.Approval.Transaction.Data[4:])
	if err != nil || values[0].(common.Address) != common.BytesToAddress(terms.Executor.Address) || values[1].(*big.Int).Cmp(big.NewInt(37)) != 0 {
		t.Fatal("approval is not finite executor allowance")
	}
	again, err := handler.PreparePlan(t.Context(), connect.NewRequest(request))
	if err != nil || again.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("old quote was promoted after approval")
	}
}

func TestPrepareAtomicPlanRejectsQuoteCandidateAndTermsSubstitution(t *testing.T) {
	chain, candidate, terms, planID := atomicPlanTestData(t)
	store := NewStore()
	quoteID := bytes.Repeat([]byte{0x14}, 32)
	store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: quoteID, Candidates: []*atomicv1.PlanCandidate{candidate}, SearchComplete: proto.Bool(true)}, time.Now())
	handler := Handler{Chains: map[string]Chain{"base": chain}, Store: store}
	base := &atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}

	missingQuote := proto.CloneOf(base)
	missingQuote.QuoteId[0]++
	response, err := handler.PreparePlan(t.Context(), connect.NewRequest(missingQuote))
	if err != nil || response.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("unknown quote did not require requote")
	}
	mutations := map[string]func(*atomicv1.PreparePlanRequest){
		"candidate ID": func(v *atomicv1.PreparePlanRequest) { v.CandidateId[0]++ },
		"program":      func(v *atomicv1.PreparePlanRequest) { v.Terms.Program.AmountIn[31]++ },
		"quote block":  func(v *atomicv1.PreparePlanRequest) { v.Terms.QuoteBlock.Hash[31]++ },
		"plan ID":      func(v *atomicv1.PreparePlanRequest) { v.PlanId[31]++ },
		"unknown":      func(v *atomicv1.PreparePlanRequest) { v.ProtoReflect().SetUnknown([]byte{0x38, 0x01}) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			request := proto.CloneOf(base)
			mutate(request)
			if _, err := handler.PreparePlan(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("substitution was not rejected: %v", err)
			}
		})
	}
}

func TestAtomicPlanRejectsMutatedTermsAndSimulationEvents(t *testing.T) {
	chain, candidate, terms, planID := atomicPlanTestData(t)
	mutations := map[string]func(*atomicv1.AcceptedPlanTerms){
		"branch minimum":    func(v *atomicv1.AcceptedPlanTerms) { v.BranchMinima[0][31]++ },
		"aggregate minimum": func(v *atomicv1.AcceptedPlanTerms) { v.AmountOutMinimum[31]++ },
		"executor":          func(v *atomicv1.AcceptedPlanTerms) { v.Executor.Address[19]++ },
		"runtime":           func(v *atomicv1.AcceptedPlanTerms) { v.Executor.RuntimeCodeHash[31]++ },
		"signer":            func(v *atomicv1.AcceptedPlanTerms) { v.Signer[19]++ },
		"recipient":         func(v *atomicv1.AcceptedPlanTerms) { v.Recipient[19]++ },
		"deadline":          func(v *atomicv1.AcceptedPlanTerms) { v.DeadlineUnix[31]++ },
		"expiry":            func(v *atomicv1.AcceptedPlanTerms) { v.ExpiresAtUnix[31]++ },
		"fee": func(v *atomicv1.AcceptedPlanTerms) {
			fee := v.Program.Branches[0].Operations[0].GetUniswapV3().FeePips
			*fee = *fee + 1
		},
		"pool":    func(v *atomicv1.AcceptedPlanTerms) { v.Program.Branches[0].Operations[0].GetUniswapV3().Pool[19]++ },
		"unknown": func(v *atomicv1.AcceptedPlanTerms) { v.Program.ProtoReflect().SetUnknown([]byte{0x38, 0x01}) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			changed := proto.CloneOf(terms)
			mutate(changed)
			if _, err := validateAcceptedAtomicTerms(chain, changed, planID.Bytes(), time.Now()); err == nil {
				t.Fatal("mutation accepted")
			}
		})
	}
	validated, err := validateAcceptedAtomicTerms(chain, terms, planID.Bytes(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	executor, signer := common.BytesToAddress(terms.Executor.Address), common.BytesToAddress(terms.Signer)
	base := atomicPlanLogs(t, executor, signer, validated.executorPlanHash, candidate.Program, 83, 61)
	withRefund := withAtomicNativeRefund(t, base, executor, signer, validated.executorPlanHash, 1)
	if _, err := validateAtomicSimulationLogs(withRefund, executor, signer, validated.executorPlanHash, candidate.Program, big.NewInt(60)); err == nil {
		t.Fatal("non-Slipstream native refund event accepted")
	}
	eventMutations := map[string]func([]SimulationLog){
		"emitter": func(v []SimulationLog) { v[0].Address[19]++ },
		"hash":    func(v []SimulationLog) { v[0].Topics[1][31]++ },
		"index padding": func(v []SimulationLog) {
			v[0].Topics[3][0] = 1
		},
		"order":       func(v []SimulationLog) { v[0], v[1] = v[1], v[0] },
		"cardinality": func(v []SimulationLog) { v[0] = v[len(v)-1] },
		"chain":       func(v []SimulationLog) { v[1].Data[127]++ },
		"branch":      func(v []SimulationLog) { v[2].Data[63]++ },
		"plan":        func(v []SimulationLog) { v[3].Data[95]++ },
		"caller padding": func(v []SimulationLog) {
			v[3].Topics[2][0] = 1
		},
	}
	for name, mutate := range eventMutations {
		t.Run("event "+name, func(t *testing.T) {
			changed := make([]SimulationLog, len(base))
			for i := range base {
				changed[i] = SimulationLog{Address: base[i].Address, Topics: append([]common.Hash(nil), base[i].Topics...), Data: append([]byte(nil), base[i].Data...)}
			}
			mutate(changed)
			if _, err := validateAtomicSimulationLogs(changed, executor, signer, validated.executorPlanHash, candidate.Program, big.NewInt(60)); err == nil {
				t.Fatal("bad events accepted")
			}
		})
	}
}

func TestAtomicStoreReturnsClonesAndExpiresRecords(t *testing.T) {
	store := NewStore()
	now := time.Now()
	id := bytes.Repeat([]byte{1}, 32)
	key := append([]byte(nil), id...)
	response := &atomicv1.PlanQuoteResponse{QuoteId: id, SearchComplete: proto.Bool(false)}
	store.saveAtomicQuote("base", response, now)
	response.QuoteId[0] = 2
	got, ok := store.atomicQuote(key, now)
	if !ok || got.response.QuoteId[0] != 1 {
		t.Fatal("store retained caller-owned quote")
	}
	got.response.QuoteId[0] = 3
	again, ok := store.atomicQuote(key, now)
	if !ok || again.response.QuoteId[0] != 1 {
		t.Fatal("store returned mutable quote")
	}
	if _, ok := store.atomicQuote(key, now.Add(retention)); ok {
		t.Fatal("expired quote remained available")
	}
	preparationID := bytes.Repeat([]byte{4}, 32)
	storedResponse := &atomicv1.PreparePlanResponse{Preparation: &atomicv1.UnsignedPreparation{PreparationId: preparationID, PlanId: bytes.Repeat([]byte{5}, 32)}}
	storedChecks := SimulationChecks{Preserve: []BalanceProbe{{Token: testWETH.Hex(), Owner: testUSDC.Hex()}}}
	store.saveAtomicPreparation(atomicPreparation{response: storedResponse, chain: "base", expires: now.Add(retention), executorPlanHash: bytes.Repeat([]byte{6}, 32), checks: storedChecks}, now)
	storedResponse.Preparation.PlanId[0] = 9
	storedChecks.Preserve[0].Token = "changed"
	plan, ok := store.atomicPreparation(preparationID, now)
	if !ok || plan.response.Preparation.PlanId[0] != 5 || plan.checks.Preserve[0].Token != testWETH.Hex() {
		t.Fatal("store retained caller-owned preparation")
	}
	plan.response.Preparation.PlanId[0] = 8
	plan.checks.Preserve[0].Token = "changed again"
	againPlan, ok := store.atomicPreparation(preparationID, now)
	if !ok || againPlan.response.Preparation.PlanId[0] != 5 || againPlan.checks.Preserve[0].Token != testWETH.Hex() {
		t.Fatal("store returned mutable preparation")
	}
	if _, ok := store.atomicPreparation(preparationID, now.Add(retention)); ok {
		t.Fatal("expired preparation remained available")
	}

	var workers sync.WaitGroup
	errors := make(chan string, 32)
	for i := byte(10); i < 42; i++ {
		workers.Add(1)
		go func(marker byte) {
			defer workers.Done()
			concurrentID := bytes.Repeat([]byte{marker}, 32)
			store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: concurrentID, SearchComplete: proto.Bool(true)}, now)
			value, found := store.atomicQuote(concurrentID, now)
			if !found || !bytes.Equal(value.response.QuoteId, concurrentID) {
				errors <- "concurrent quote lost or changed"
			}
		}(i)
	}
	workers.Wait()
	close(errors)
	for message := range errors {
		t.Fatal(message)
	}
}
