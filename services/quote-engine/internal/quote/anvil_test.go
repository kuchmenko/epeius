package quote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

func TestAnvilSimulatorUsesPinnedTraceTransferDeltas(t *testing.T) {
	const (
		wallet = "0x1111111111111111111111111111111111111111"
		router = "0x2222222222222222222222222222222222222222"
		pool   = "0x3333333333333333333333333333333333333333"
		input  = "0x4444444444444444444444444444444444444444"
		output = "0x5555555555555555555555555555555555555555"
	)
	topic := func(address string) string { return "0x" + strings.Repeat("0", 24) + address[2:] }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage   `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		var result any
		switch request.Method {
		case "web3_clientVersion":
			result = "anvil/v1.5.0"
		case "eth_chainId":
			result = "0x2105"
		case "debug_traceCall":
			if len(request.Params) != 3 || string(request.Params[1]) != `{"blockHash":"`+blockHash+`","requireCanonical":true}` {
				t.Errorf("trace was not pinned to block hash: %s", request.Params)
			}
			result = map[string]any{
				"from": wallet, "to": router, "input": "0xaabb", "type": "CALL",
				"calls": []any{
					map[string]any{
						"from": wallet, "to": pool, "input": "0x", "type": "CALL",
						"logs": []any{
							map[string]any{"address": input, "topics": []string{transferTopic.Hex(), topic(wallet), topic(pool)}, "data": "0x" + strings.Repeat("00", 31) + "65"},
							map[string]any{"address": output, "topics": []string{transferTopic.Hex(), topic(pool), topic(wallet)}, "data": "0x" + strings.Repeat("00", 30) + "00fd"},
						},
					},
				},
			}
		default:
			t.Errorf("unexpected RPC method %s", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}))
	defer server.Close()

	simulator, err := NewAnvilSimulator(context.Background(), server.URL, "8453")
	if err != nil {
		t.Fatal(err)
	}
	defer simulator.Close()
	tx := &quotev1.UnsignedTransaction{ChainId: "8453", From: wallet, To: router, Data: "0xaabb", ValueAtomic: "0", GasLimit: "300000"}
	checks := SimulationChecks{Input: BalanceProbe{input, wallet}, Output: BalanceProbe{output, wallet}, Preserve: []BalanceProbe{{input, router}, {output, router}}}
	got, err := simulator.Simulate(context.Background(), tx, checks, rpc.Snapshot{ChainID: "8453", BlockHash: blockHash}, big.NewInt(101), big.NewInt(252))
	if err != nil || got != "253" {
		t.Fatalf("output=%q error=%v", got, err)
	}
	if _, err := simulator.Simulate(context.Background(), tx, checks, rpc.Snapshot{ChainID: "8453", BlockHash: blockHash}, big.NewInt(100), big.NewInt(252)); !errors.Is(err, errSimulationInputAmount) {
		t.Fatalf("wrong input delta accepted: %v", err)
	}
	if _, err := simulator.Simulate(context.Background(), tx, checks, rpc.Snapshot{ChainID: "8453", BlockHash: blockHash}, big.NewInt(101), big.NewInt(254)); !errors.Is(err, errSimulationMinimumOutput) {
		t.Fatalf("output below minimum accepted: %v", err)
	}
}

func TestAnvilSimulatorRejectsNonLoopbackEndpoint(t *testing.T) {
	if _, err := NewAnvilSimulator(context.Background(), "https://example.com", "8453"); err == nil {
		t.Fatal("non-loopback endpoint accepted")
	}
}

func TestAnvilSimulatorRequiresOrderedAllowanceEvidence(t *testing.T) {
	const (
		wallet   = "0x1111111111111111111111111111111111111111"
		executor = "0x2222222222222222222222222222222222222222"
		input    = "0x3333333333333333333333333333333333333333"
		output   = "0x4444444444444444444444444444444444444444"
		spenderA = "0x5555555555555555555555555555555555555555"
		spenderB = "0x6666666666666666666666666666666666666666"
		parent   = "0x7777777777777777777777777777777777777777777777777777777777777777"
	)
	topic := func(address string) string { return "0x" + strings.Repeat("0", 24) + address[2:] }
	tx := &quotev1.UnsignedTransaction{ChainId: "8453", From: wallet, To: executor, Data: "0xaabb", ValueAtomic: "0", GasLimit: "300000"}
	baseChecks := SimulationChecks{
		Input:  BalanceProbe{input, wallet},
		Output: BalanceProbe{output, wallet},
		ClearAllowances: []AllowanceProbe{
			{Token: input, Owner: executor, Spender: spenderA},
			{Token: output, Owner: executor, Spender: spenderB},
		},
	}
	logs := []anvilLog{
		{Address: common.HexToAddress(input), Topics: []common.Hash{transferTopic, common.HexToHash(topic(wallet)), common.HexToHash(topic(executor))}, Data: uintWord(101)},
		{Address: common.HexToAddress(output), Topics: []common.Hash{transferTopic, common.HexToHash(topic(executor)), common.HexToHash(topic(wallet))}, Data: uintWord(253)},
	}
	tests := map[string]struct {
		probes      int
		mutate      func(*anvilSimulationBlock)
		mutateHead  func(map[string]any)
		unavailable bool
		want        error
	}{
		"one allowance":                  {probes: 1},
		"multiple asymmetric allowances": {probes: 2},
		"nonzero residue": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Calls[2].ReturnData = hexutil.Encode(uintWord(1))
		}, want: errSimulationAllowance},
		"failed executor": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Calls[0].Status = "0x0"
		}, want: errSimulationEvidence},
		"failed probe": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Calls[1].Status = "0x0"
		}, want: errSimulationEvidence},
		"malformed probe": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Calls[1].ReturnData = "0x00"
		}, want: errSimulationEvidence},
		"missing call result": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Calls = block.Calls[:2]
		}, want: errSimulationEvidence},
		"extra call result": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Calls = append(block.Calls, block.Calls[2])
		}, want: errSimulationEvidence},
		"missing transaction identity": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Transactions = block.Transactions[:2]
		}, want: errSimulationEvidence},
		"extra transaction identity": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Transactions = append(block.Transactions, block.Transactions[2])
		}, want: errSimulationEvidence},
		"reordered transaction identity": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Transactions[1], block.Transactions[2] = block.Transactions[2], block.Transactions[1]
		}, want: errSimulationEvidence},
		"wrong result block": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.Number = "0x12d688"
		}, want: errSimulationEvidence},
		"wrong result parent": {probes: 2, mutate: func(block *anvilSimulationBlock) {
			block.ParentHash = common.HexToHash("0x88").Hex()
		}, want: errSimulationEvidence},
		"wrong pinned header": {probes: 2, mutateHead: func(header map[string]any) {
			header["hash"] = common.HexToHash("0x99").Hex()
		}, want: errSimulationEvidence},
		"simulate unavailable": {probes: 2, unavailable: true, want: errSimulationUnavailable},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			checks := baseChecks
			checks.ClearAllowances = append([]AllowanceProbe(nil), baseChecks.ClearAllowances[:test.probes]...)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					ID     json.RawMessage   `json:"id"`
					Method string            `json:"method"`
					Params []json.RawMessage `json:"params"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
					return
				}
				var result any
				switch request.Method {
				case "web3_clientVersion":
					result = "anvil/v1.5.0"
				case "eth_chainId":
					result = "0x2105"
				case "eth_getBlockByHash":
					if len(request.Params) != 2 || string(request.Params[0]) != `"`+blockHash+`"` || string(request.Params[1]) != "false" {
						t.Errorf("wrong pinned header request: %s", request.Params)
					}
					header := map[string]any{"number": "0x12d687", "hash": blockHash, "parentHash": parent}
					if test.mutateHead != nil {
						test.mutateHead(header)
					}
					result = header
				case "eth_simulateV1":
					if test.unavailable {
						_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
						return
					}
					if len(request.Params) != 2 || string(request.Params[1]) != `{"blockHash":"`+blockHash+`","requireCanonical":true}` {
						t.Errorf("simulation was not hash pinned: %s", request.Params)
					}
					var payload struct {
						BlockStateCalls []struct {
							Calls []anvilSimulationCall `json:"calls"`
						} `json:"blockStateCalls"`
						Validation, TraceTransfers, ReturnFullTransactions bool
					}
					if err := json.Unmarshal(request.Params[0], &payload); err != nil || len(payload.BlockStateCalls) != 1 || len(payload.BlockStateCalls[0].Calls) != test.probes+1 || payload.Validation || payload.TraceTransfers || !payload.ReturnFullTransactions {
						t.Fatalf("invalid simulation payload: %+v %v", payload, err)
					}
					calls := payload.BlockStateCalls[0].Calls
					if calls[0] != (anvilSimulationCall{From: wallet, To: executor, Data: "0xaabb", Value: "0x0", Gas: "0x493e0"}) {
						t.Fatalf("first call changed: %+v", calls[0])
					}
					for i, probe := range checks.ClearAllowances {
						data, _ := erc20ABI.Pack("allowance", common.HexToAddress(probe.Owner), common.HexToAddress(probe.Spender))
						want := anvilSimulationCall{From: wallet, To: probe.Token, Data: hexutil.Encode(data), Value: "0x0", Gas: "0x493e0"}
						if calls[i+1] != want {
							t.Fatalf("probe %d changed: %+v", i, calls[i+1])
						}
					}
					block := anvilSimulationBlock{Number: "0x12d687", Hash: common.HexToHash("0xaa").Hex(), ParentHash: parent}
					for i, call := range calls {
						block.Transactions = append(block.Transactions, anvilSimulationTransaction{From: call.From, To: call.To, Input: call.Data, Value: call.Value, Gas: call.Gas, Hash: common.BigToHash(big.NewInt(int64(i + 1))).Hex()})
						returned := "0x"
						if i != 0 {
							returned = hexutil.Encode(uintWord(0))
						}
						block.Calls = append(block.Calls, anvilSimulationResult{Status: "0x1", ReturnData: returned})
					}
					block.Calls[0].Logs = logs
					if test.mutate != nil {
						test.mutate(&block)
					}
					result = []anvilSimulationBlock{block}
				default:
					t.Errorf("unexpected RPC method %s", request.Method)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			}))
			defer server.Close()
			simulator, err := NewAnvilSimulator(t.Context(), server.URL, "8453")
			if err != nil {
				t.Fatal(err)
			}
			defer simulator.Close()
			got, err := simulator.SimulateAtomic(t.Context(), tx, checks, rpc.Snapshot{ChainID: "8453", BlockNumber: "1234567", BlockHash: blockHash}, big.NewInt(101), big.NewInt(252))
			if !errors.Is(err, test.want) {
				t.Fatalf("result=%+v error=%v, want %v", got, err, test.want)
			}
			if test.want == nil && (got.Output != "253" || len(got.Logs) != 2) {
				t.Fatalf("valid allowance evidence changed output: %+v", got)
			}
		})
	}
}

func TestRealAnvilSequentialAllowanceProbeIsReadOnly(t *testing.T) {
	if _, err := exec.LookPath("anvil"); err != nil {
		t.Skip("anvil is not installed")
	}
	const (
		token    = "0x1000000000000000000000000000000000000001"
		executor = "0x2000000000000000000000000000000000000002"
		spender  = "0x0000000000000000000000000000000000000003"
		wallet   = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	)
	// Genesis code is a synthetic ERC20 allowance/approve fixture plus an
	// executor that clears its token allowance. It provides initial state
	// without any mutation RPC, transaction, override, or impersonation.
	tokenRuntime := "60003560e01c8063dd62ed3e14602e5763095ea7b314601d57600080fd5b602435600055600160005260206000f35b60005460005260206000f3"
	executorRuntime := "63095ea7b360e01b600052730000000000000000000000000000000000000003600452602060006044600060007310000000000000000000000000000000000000015af15000"
	directory := t.TempDir()
	genesis := filepath.Join(directory, "genesis.json")
	content := fmt.Sprintf(`{"config":{"chainId":8453},"alloc":{"%s":{"balance":"0x0","code":"0x%s","storage":{"0x%064x":"0x%064x"}},"%s":{"balance":"0x0","code":"0x%s"}},"gasLimit":"0x1c9c380"}`, token, tokenRuntime, 0, 7, executor, executorRuntime)
	if err := os.WriteFile(genesis, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	command := exec.Command("anvil", "--init", genesis, "--number", "123", "--chain-id", "8453", "--port", strconv.Itoa(port), "--no-mining", "--silent")
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	})
	endpoint := fmt.Sprintf("http://127.0.0.1:%d", port)
	var simulator *AnvilSimulator
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		simulator, err = NewAnvilSimulator(t.Context(), endpoint, "8453")
		if err == nil {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if err != nil {
		t.Fatal("Anvil did not start")
	}
	defer simulator.Close()
	var header anvilSimulationBlock
	if err := simulator.client.CallContext(t.Context(), &header, "eth_getBlockByNumber", "latest", false); err != nil {
		t.Fatal(err)
	}
	snapshot := rpc.Snapshot{ChainID: "8453", BlockNumber: "123", BlockHash: header.Hash}
	probe := AllowanceProbe{Token: token, Owner: executor, Spender: spender}
	allowanceData, _ := erc20ABI.Pack("allowance", common.HexToAddress(executor), common.HexToAddress(spender))
	read := func() *big.Int {
		var raw hexutil.Bytes
		if err := simulator.client.CallContext(t.Context(), &raw, "eth_call", map[string]any{"to": token, "data": hexutil.Encode(allowanceData)}, "latest"); err != nil {
			t.Fatal(err)
		}
		values, err := erc20ABI.Methods["allowance"].Outputs.Unpack(raw)
		if err != nil {
			t.Fatal(err)
		}
		return values[0].(*big.Int)
	}
	if before := read(); before.Cmp(big.NewInt(7)) != 0 {
		t.Fatalf("wrong genesis allowance: %s", before)
	}
	tx := &quotev1.UnsignedTransaction{ChainId: "8453", From: wallet, To: executor, Data: "0xaabb", ValueAtomic: "0", GasLimit: "1048576"}
	if _, err := simulator.simulateAllowanceBundle(t.Context(), tx, []AllowanceProbe{probe}, snapshot, 1_048_576); err != nil {
		t.Fatal(err)
	}
	if after := read(); after.Cmp(big.NewInt(7)) != 0 {
		t.Fatalf("eth_simulateV1 committed state: %s", after)
	}
}

func TestAtomicPrepareAndRecheckUseAnvilAllowanceEvidence(t *testing.T) {
	tests := map[string]func(*testing.T) (Chain, *atomicv1.PlanCandidate, *atomicv1.AcceptedPlanTerms, common.Hash){
		"Uniswap router":    atomicPlanTestData,
		"Pancake router":    pancakeAtomicPlanTestData,
		"Slipstream router": slipstreamAtomicPlanTestData,
		"Balancer Vault":    balancerAtomicPlanTestData,
		"Permit2":           v4AnvilPlanTestData,
	}
	for name, fixture := range tests {
		t.Run(name, func(t *testing.T) {
			chain, candidate, terms, planID := fixture(t)
			now := uint64(time.Now().Unix())
			snapshots := []rpc.Snapshot{
				{ChainID: "8453", BlockNumber: "12345679", BlockHash: common.HexToHash("0xbb").Hex(), Timestamp: now},
				{ChainID: "8453", BlockNumber: "12345680", BlockHash: common.HexToHash("0xcc").Hex(), Timestamp: now},
			}
			reader := &atomicPlanReader{config: chain.Config, program: candidate.Program, runtime: []byte{1, 2, 3, 4}, allowance: big.NewInt(37), snapshots: append([]rpc.Snapshot(nil), snapshots...)}
			chain.Client = reader
			if chain.Config.AtomicExecutor.UniswapV4Deployment != "" {
				chain.Client = &v4AnvilReader{atomicPlanReader: reader}
			}
			validated, err := validateAcceptedAtomicTerms(chain, terms, planID.Bytes(), time.Now())
			if err != nil {
				t.Fatal(err)
			}
			outputs := []int64{83, 61}
			if len(candidate.Program.Branches[0].Operations) == 1 {
				outputs = []int64{61}
			}
			executor, signer := common.BytesToAddress(terms.Executor.Address), common.BytesToAddress(terms.Signer)
			simulationLogs := atomicPlanLogs(t, executor, signer, validated.executorPlanHash, candidate.Program, outputs...)
			topic := func(address common.Address) common.Hash {
				return common.BytesToHash(common.LeftPadBytes(address.Bytes(), 32))
			}
			pool := common.HexToAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
			logs := []anvilLog{
				{Address: common.BytesToAddress(candidate.Program.TokenIn), Topics: []common.Hash{transferTopic, topic(signer), topic(executor)}, Data: uintWord(37)},
				{Address: common.BytesToAddress(candidate.Program.TokenIn), Topics: []common.Hash{transferTopic, topic(executor), topic(pool)}, Data: uintWord(37)},
				{Address: common.BytesToAddress(candidate.Program.TokenOut), Topics: []common.Hash{transferTopic, topic(pool), topic(executor)}, Data: uintWord(61)},
				{Address: common.BytesToAddress(candidate.Program.TokenOut), Topics: []common.Hash{transferTopic, topic(executor), topic(signer)}, Data: uintWord(61)},
			}
			for _, log := range simulationLogs {
				logs = append(logs, anvilLog{Address: log.Address, Topics: log.Topics, Data: log.Data})
			}
			bundles := 0
			server := newAtomicSimulationServer(t, validated.transaction, validated.checks.ClearAllowances, snapshots, logs, &bundles)
			defer server.Close()
			simulator, err := NewAnvilSimulator(t.Context(), server.URL, "8453")
			if err != nil {
				t.Fatal(err)
			}
			defer simulator.Close()
			store := NewStore()
			quoteID := bytes.Repeat([]byte{byte(len(name))}, 32)
			store.saveAtomicQuote("base", &atomicv1.PlanQuoteResponse{QuoteId: quoteID, Candidates: []*atomicv1.PlanCandidate{candidate}, SearchComplete: proto.Bool(true)}, time.Now())
			handler := Handler{Chains: map[string]Chain{"base": chain}, Store: store, Simulator: simulator}
			prepared, err := handler.PreparePlan(t.Context(), connect.NewRequest(&atomicv1.PreparePlanRequest{QuoteId: quoteID, CandidateId: candidate.CandidateId, Terms: terms, PlanId: planID.Bytes()}))
			if err != nil || prepared.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY {
				t.Fatalf("prepare did not use allowance evidence: %+v %v", prepared, err)
			}
			frozen := proto.CloneOf(prepared.Msg.Preparation)
			rechecked, err := handler.RecheckPlan(t.Context(), connect.NewRequest(&atomicv1.RecheckPlanRequest{PreparationId: frozen.PreparationId, PlanId: planID.Bytes()}))
			if err != nil || rechecked.Msg.GetStatus() != atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY || !proto.Equal(frozen, rechecked.Msg.Preparation) || bundles != 2 {
				t.Fatalf("recheck did not rerun allowance evidence: bundles=%d response=%+v error=%v", bundles, rechecked, err)
			}
		})
	}
}

type v4AnvilReader struct{ *atomicPlanReader }

func (r *v4AnvilReader) Call(ctx context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
	deployment := r.config.Deployments[r.config.AtomicExecutor.UniswapV4Deployment]
	options := deployment.ProviderConfig.(uniswapv4.Options)
	manager := common.HexToAddress(options.PoolManager)
	for target, method := range map[common.Address]abi.Method{
		common.HexToAddress(deployment.Quoter): contractabi.UniswapV4Quoter.Methods["poolManager"],
		common.HexToAddress(options.StateView): contractabi.UniswapV4StateView.Methods["poolManager"],
		common.HexToAddress(deployment.Router): contractabi.UniswapUniversalRouter.Methods["poolManager"],
	} {
		if to == target && len(data) >= 4 && bytes.Equal(data[:4], method.ID) {
			return method.Outputs.Pack(manager)
		}
	}
	if to == common.HexToAddress(options.StateView) && len(data) >= 4 && bytes.Equal(data[:4], contractabi.UniswapV4StateView.Methods["getSlot0"].ID) {
		return contractabi.UniswapV4StateView.Methods["getSlot0"].Outputs.Pack(big.NewInt(1), big.NewInt(0), big.NewInt(0), big.NewInt(0))
	}
	return r.atomicPlanReader.Call(ctx, to, data, hash)
}

func v4AnvilPlanTestData(t *testing.T) (Chain, *atomicv1.PlanCandidate, *atomicv1.AcceptedPlanTerms, common.Hash) {
	t.Helper()
	input := common.HexToAddress("0x1111111111111111111111111111111111111111")
	output := common.HexToAddress("0x3333333333333333333333333333333333333333")
	executor := common.HexToAddress("0x6666666666666666666666666666666666666666")
	signer := common.HexToAddress("0x7777777777777777777777777777777777777777")
	runtimeHash := crypto.Keccak256Hash([]byte{1, 2, 3, 4}).Hex()
	options := uniswapv4.Options{
		PoolManager:     common.HexToAddress("0x8888888888888888888888888888888888888888").Hex(),
		StateView:       common.HexToAddress("0x9999999999999999999999999999999999999999").Hex(),
		Permit2:         common.HexToAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").Hex(),
		RouterCodeHash:  runtimeHash,
		Permit2CodeHash: runtimeHash,
		Pools:           []uniswapv4.Pool{{Currency0: input.Hex(), Currency1: output.Hex(), FeePips: 500, TickSpacing: 10, Hooks: common.Address{}.Hex()}},
	}
	deployment := config.Deployment{Kind: "uniswap-v4", Router: common.HexToAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").Hex(), Quoter: common.HexToAddress("0xcccccccccccccccccccccccccccccccccccccccc").Hex(), ProviderConfig: options}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(big.NewInt(12345678)), Hash: common.HexToHash("0xaa").Bytes()}
	candidate, err := atomicV4Candidate(big.NewInt(8453), big.NewInt(37), input, output, options, options.Pools[0], block, big.NewInt(77))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	terms := &atomicv1.AcceptedPlanTerms{
		Program: candidate.Program, Executor: &atomicv1.ExecutorIdentity{Address: executor.Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: common.HexToHash(runtimeHash).Bytes()},
		Signer: signer.Bytes(), Recipient: signer.Bytes(), BranchMinima: [][]byte{uint256Bytes(big.NewInt(60))}, AmountOutMinimum: uint256Bytes(big.NewInt(60)), QuoteBlock: block, ExpiresAtUnix: uint256Bytes(big.NewInt(now + 20)), DeadlineUnix: uint256Bytes(big.NewInt(now + 25)),
	}
	planID, err := atomicV1PlanID(terms)
	if err != nil {
		t.Fatal(err)
	}
	chain := Chain{ChainID: "8453", Config: config.Chain{
		ChainID: 8453, ExecutionEnabled: true, Tokens: []config.Token{{Address: input.Hex()}, {Address: output.Hex()}}, Deployments: map[string]config.Deployment{"v4": deployment},
		AtomicExecutor: &config.AtomicExecutor{Address: executor.Hex(), RuntimeCodeHash: runtimeHash, UniswapV4Deployment: "v4"},
	}}
	return chain, candidate, terms, planID
}

func newAtomicSimulationServer(t *testing.T, transaction *quotev1.UnsignedTransaction, probes []AllowanceProbe, snapshots []rpc.Snapshot, logs []anvilLog, bundles *int) *httptest.Server {
	t.Helper()
	byHash := make(map[string]rpc.Snapshot, len(snapshots))
	for _, snapshot := range snapshots {
		byHash[strings.ToLower(snapshot.BlockHash)] = snapshot
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage   `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		var result any
		switch request.Method {
		case "web3_clientVersion":
			result = "anvil/v1.5.0"
		case "eth_chainId":
			result = "0x2105"
		case "eth_getBlockByHash":
			var hash string
			_ = json.Unmarshal(request.Params[0], &hash)
			snapshot, ok := byHash[strings.ToLower(hash)]
			if !ok {
				t.Fatalf("unexpected header hash %s", hash)
			}
			number, _ := strconv.ParseUint(snapshot.BlockNumber, 10, 64)
			result = map[string]any{"number": hexutil.EncodeUint64(number), "hash": snapshot.BlockHash, "parentHash": common.BigToHash(big.NewInt(int64(number - 1))).Hex()}
		case "eth_simulateV1":
			*bundles = *bundles + 1
			var block gethrpc.BlockNumberOrHash
			if err := json.Unmarshal(request.Params[1], &block); err != nil || block.BlockHash == nil || !block.RequireCanonical || byHash[strings.ToLower(block.BlockHash.Hex())].BlockHash == "" {
				t.Fatalf("simulation was not canonically pinned: %s", request.Params[1])
			}
			var payload struct {
				BlockStateCalls []struct {
					Calls []anvilSimulationCall `json:"calls"`
				} `json:"blockStateCalls"`
			}
			if err := json.Unmarshal(request.Params[0], &payload); err != nil || len(payload.BlockStateCalls) != 1 || len(payload.BlockStateCalls[0].Calls) != len(probes)+1 {
				t.Fatalf("wrong allowance bundle: %+v %v", payload, err)
			}
			calls := payload.BlockStateCalls[0].Calls
			gas, _ := strconv.ParseUint(transaction.GasLimit, 10, 64)
			if calls[0] != (anvilSimulationCall{From: transaction.From, To: transaction.To, Data: transaction.Data, Value: "0x0", Gas: hexutil.EncodeUint64(gas)}) {
				t.Fatalf("executor transaction changed: %+v", calls[0])
			}
			for i, probe := range probes {
				data, _ := erc20ABI.Pack("allowance", common.HexToAddress(probe.Owner), common.HexToAddress(probe.Spender))
				if calls[i+1].To != probe.Token || calls[i+1].Data != hexutil.Encode(data) {
					t.Fatalf("allowance probe %d changed: %+v", i, calls[i+1])
				}
			}
			snapshot := byHash[strings.ToLower(block.BlockHash.Hex())]
			number, _ := strconv.ParseUint(snapshot.BlockNumber, 10, 64)
			response := anvilSimulationBlock{Number: hexutil.EncodeUint64(number), Hash: common.BigToHash(big.NewInt(int64(number + 1))).Hex(), ParentHash: common.BigToHash(big.NewInt(int64(number - 1))).Hex()}
			for i, call := range calls {
				response.Transactions = append(response.Transactions, anvilSimulationTransaction{From: call.From, To: call.To, Input: call.Data, Value: call.Value, Gas: call.Gas, Hash: common.BigToHash(big.NewInt(int64(i + 1))).Hex()})
				returned := "0x"
				if i != 0 {
					returned = hexutil.Encode(uintWord(0))
				}
				response.Calls = append(response.Calls, anvilSimulationResult{Status: "0x1", ReturnData: returned})
			}
			response.Calls[0].Logs = logs
			result = []anvilSimulationBlock{response}
		default:
			t.Fatalf("unexpected RPC method %s", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}))
}
