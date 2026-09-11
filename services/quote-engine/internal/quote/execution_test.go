package quote

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

const tokenA = "0x1111111111111111111111111111111111111111"
const tokenB = "0x2222222222222222222222222222222222222222"
const tokenC = "0x3333333333333333333333333333333333333333"
const wallet = "0x7777777777777777777777777777777777777777"
const router = "0x8888888888888888888888888888888888888888"

func testRoute() *quotev1.RouteQuote {
	return &quotev1.RouteQuote{RouteId: "uni:500:middle:3000", DeploymentId: "uni", Provider: "uniswap-v3", AmountOutAtomic: "10003", Legs: []*quotev1.RouteLeg{
		{Pool: tokenA, TokenIn: tokenA, TokenOut: tokenB, Selector: &quotev1.RouteLeg_FeePips{FeePips: 500}},
		{Pool: tokenC, TokenIn: tokenB, TokenOut: tokenC, Selector: &quotev1.RouteLeg_FeePips{FeePips: 3000}},
	}}
}

func TestSwapCalldataAuthenticSelectorsAndDeadline(t *testing.T) {
	route := testRoute()
	amount := big.NewInt(123456789)
	minimum := big.NewInt(9927)
	for _, kind := range []string{"uniswap-v3", "pancake-v3"} {
		data, err := swapData(kind, route, wallet, amount, minimum, 1777777777)
		if err != nil {
			t.Fatal(err)
		}
		signature := "exactInput((bytes,address,uint256,uint256,uint256))"
		if kind == "uniswap-v3" {
			if !bytes.Equal(data[:4], crypto.Keccak256([]byte("multicall(uint256,bytes[])"))[:4]) {
				t.Fatal("missing deadline multicall")
			}
			values, err := uniRouterABI.Methods["multicall"].Inputs.Unpack(data[4:])
			if err != nil {
				t.Fatal(err)
			}
			if values[0].(*big.Int).Uint64() != 1777777777 || len(values[1].([][]byte)) != 1 {
				t.Fatal("deadline or call count changed")
			}
			data = values[1].([][]byte)[0]
			signature = "exactInput((bytes,address,uint256,uint256))"
		}
		if !bytes.Equal(data[:4], crypto.Keccak256([]byte(signature))[:4]) {
			t.Fatal("wrong router selector")
		}
		// Independently inspect ABI words: tuple offset, path offset, recipient, optional deadline, amount, minimum.
		tuple := data[36:]
		if common.BytesToAddress(tuple[32:64]).Hex() != common.HexToAddress(wallet).Hex() {
			t.Fatal("recipient changed")
		}
		amountOffset := 64
		if kind == "pancake-v3" {
			if new(big.Int).SetBytes(tuple[64:96]).Uint64() != 1777777777 {
				t.Fatal("missing tuple deadline")
			}
			amountOffset = 96
		}
		if new(big.Int).SetBytes(tuple[amountOffset:amountOffset+32]).Cmp(amount) != 0 || new(big.Int).SetBytes(tuple[amountOffset+32:amountOffset+64]).Cmp(minimum) != 0 {
			t.Fatal("amount terms changed")
		}
		offset := new(big.Int).SetBytes(tuple[:32]).Int64()
		length := new(big.Int).SetBytes(tuple[offset : offset+32]).Int64()
		path := tuple[offset+32 : offset+32+length]
		expected := append(common.HexToAddress(tokenA).Bytes(), 0, 1, 244)
		expected = append(expected, common.HexToAddress(tokenB).Bytes()...)
		expected = append(expected, 0, 11, 184)
		expected = append(expected, common.HexToAddress(tokenC).Bytes()...)
		if !bytes.Equal(path, expected) {
			t.Fatalf("path=%x", path)
		}
	}
	route.Legs[0].Selector = &quotev1.RouteLeg_TickSpacing{TickSpacing: 500}
	if _, err := swapData("uniswap-v3", route, wallet, amount, minimum, 123); err == nil {
		t.Fatal("tick spacing accepted as fee")
	}
}

type executionFake struct {
	readerFake
	canonical func(context.Context, rpc.Snapshot) error
}

func TestSwapCalldataAcceptsConfiguredZeroFee(t *testing.T) {
	route := testRoute()
	route.Legs = route.Legs[:1]
	route.Legs[0].Selector = &quotev1.RouteLeg_FeePips{FeePips: 0}
	data, err := swapData("pancake-v3", route, wallet, big.NewInt(17), big.NewInt(3), 1777777777)
	if err != nil {
		t.Fatal(err)
	}
	tuple := data[36:]
	offset := new(big.Int).SetBytes(tuple[:32]).Int64()
	length := new(big.Int).SetBytes(tuple[offset : offset+32]).Int64()
	expected := append(common.HexToAddress(tokenA).Bytes(), 0, 0, 0)
	expected = append(expected, common.HexToAddress(tokenB).Bytes()...)
	if !bytes.Equal(tuple[offset+32:offset+32+length], expected) {
		t.Fatal("zero fee changed in router path")
	}
}

func (r executionFake) Canonical(ctx context.Context, s rpc.Snapshot) error {
	return r.canonical(ctx, s)
}

type simulationFake func(context.Context, *quotev1.UnsignedTransaction, *quotev1.RouteQuote, rpc.Snapshot, *big.Int, *big.Int) (string, error)

func (f simulationFake) Simulate(ctx context.Context, tx *quotev1.UnsignedTransaction, r *quotev1.RouteQuote, s rpc.Snapshot, a, m *big.Int) (string, error) {
	return f(ctx, tx, r, s, a, m)
}

func executionFixture(t *testing.T) (Handler, *quotev1.PrepareExecutionRequest, *uint64, *uint64, *int) {
	t.Helper()
	allowance := uint64(123456789)
	timestamp := uint64(1777777000)
	simulations := 0
	reader := executionFake{readerFake: readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) {
		return rpc.Snapshot{ChainID: "11155111", BlockNumber: "112233", BlockHash: blockHash, Timestamp: timestamp}, nil
	}, call: func(ctx context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
		if to != common.HexToAddress(tokenA) || hash != common.HexToHash(blockHash) || !bytes.Equal(data[:4], crypto.Keccak256([]byte("allowance(address,address)"))[:4]) || common.BytesToAddress(data[4:36]) != common.HexToAddress(wallet) || common.BytesToAddress(data[36:68]) != common.HexToAddress(router) {
			t.Fatal("wrong allowance read")
		}
		return uintWord(allowance), nil
	}}, canonical: func(context.Context, rpc.Snapshot) error { return nil }}
	h := Handler{Store: NewStore(), Chains: map[string]Chain{"test": {ChainID: "11155111", Client: reader, Config: config.Chain{ExecutionEnabled: true, Deployments: map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Router: router}}}}}, Simulator: simulationFake(func(ctx context.Context, tx *quotev1.UnsignedTransaction, r *quotev1.RouteQuote, s rpc.Snapshot, a, m *big.Int) (string, error) {
		simulations++
		if tx.ChainId != "11155111" || s.ChainID != "11155111" || tx.From != wallet || tx.To != router || tx.ValueAtomic != "0" || tx.GasLimit != "1500000" || a.String() != "123456789" || m.String() != "9927" {
			t.Fatal("simulation terms changed")
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("missing timeout")
		}
		return "9991", nil
	}), QuoteConcurrency: 4}
	h.Store.saveQuote(&quotev1.QuoteRequest{Chain: "test", ChainId: "11155111", TokenIn: tokenA, TokenOut: tokenC, AmountInAtomic: "123456789"}, &quotev1.QuoteFinal{QuoteId: "q", Routes: []*quotev1.RouteQuote{testRoute()}, Block: &quotev1.BlockContext{Number: "112230", Hash: blockHash}}, time.Now())
	return h, &quotev1.PrepareExecutionRequest{QuoteId: "q", RouteId: testRoute().RouteId, Sender: wallet, SlippageBps: 75}, &allowance, &timestamp, &simulations
}

func prepare(t *testing.T, h Handler, r *quotev1.PrepareExecutionRequest) *quotev1.PrepareExecutionResponse {
	t.Helper()
	response, err := h.PrepareExecution(context.Background(), connect.NewRequest(r))
	if err != nil {
		t.Fatal(err)
	}
	return response.Msg
}

func TestPreparationRecheckPreservesEveryTransactionTerm(t *testing.T) {
	h, r, _, timestamp, count := executionFixture(t)
	first := prepare(t, h, r)
	if first.Status != quotev1.PreparationStatus_PREPARATION_STATUS_READY || first.DeadlineUnix != "1777777120" || first.AmountOutMinimumAtomic != "9927" || first.PreparationId == "" || first.SimulatedAmountOutAtomic != "9991" {
		t.Fatalf("%+v", first)
	}
	*timestamp += 17
	second := prepare(t, h, &quotev1.PrepareExecutionRequest{PreparationId: first.PreparationId})
	if !proto.Equal(first.Transaction, second.Transaction) || first.ExpiresAtUnix != second.ExpiresAtUnix || first.DeadlineUnix != second.DeadlineUnix || first.AmountOutMinimumAtomic != second.AmountOutMinimumAtomic || *count != 2 {
		t.Fatal("recheck mutated terms or skipped simulation")
	}
	*timestamp = 1777777120
	expired := prepare(t, h, &quotev1.PrepareExecutionRequest{PreparationId: first.PreparationId})
	if expired.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED || expired.Transaction != nil || expired.ApprovalTransaction != nil || expired.Message != "Quote or preparation expired; request a fresh quote." || *count != 2 {
		t.Fatal("deadline boundary executed")
	}
}

func TestManualNonwinnerPreparationKeepsSelectedRouteAndMinimum(t *testing.T) {
	h, request, _, _, _ := executionFixture(t)
	winner := proto.Clone(testRoute()).(*quotev1.RouteQuote)
	winner.RouteId, winner.AmountOutAtomic = "uni:winner", "20006"
	selected := testRoute()
	h.Store.saveQuote(&quotev1.QuoteRequest{Chain: "test", ChainId: "11155111", TokenIn: tokenA, TokenOut: tokenC, AmountInAtomic: "123456789"}, &quotev1.QuoteFinal{QuoteId: "manual", Routes: []*quotev1.RouteQuote{winner, selected}, BestRouteId: &winner.RouteId, Block: &quotev1.BlockContext{Number: "112230", Hash: blockHash}}, time.Now())
	request.QuoteId = "manual"
	got := prepare(t, h, request)
	if got.Status != quotev1.PreparationStatus_PREPARATION_STATUS_READY || !proto.Equal(got.Route, selected) || got.AmountOutMinimumAtomic != "9927" {
		t.Fatalf("recommendation replaced manual route: %+v", got)
	}
}

func TestExecutionStillRequiresExplicitEnablementAndMatchingNetwork(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		h, r, _, _, count := executionFixture(t)
		chain := h.Chains["test"]
		if mismatch {
			chain.ChainID = "84532"
		} else {
			chain.Config.ExecutionEnabled = false
		}
		h.Chains["test"] = chain
		response := prepare(t, h, r)
		if response.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED || response.Transaction != nil || *count != 0 {
			t.Fatalf("unsafe execution accepted: %+v", response)
		}
	}
}

func TestApprovalNeverUsesVirtualAllowanceOrUpgradesOldPreparation(t *testing.T) {
	h, r, allowance, _, count := executionFixture(t)
	*allowance = 7
	first := prepare(t, h, r)
	if first.Status != quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED || first.Transaction != nil || first.ApprovalTransaction == nil || first.PreparationId == "" || first.Message != "Approve the required amount, then request a fresh quote." || *count != 0 {
		t.Fatalf("%+v", first)
	}
	data, _ := hexutil.Decode(first.ApprovalTransaction.Data)
	if !bytes.Equal(data[:4], crypto.Keccak256([]byte("approve(address,uint256)"))[:4]) || common.BytesToAddress(data[4:36]) != common.HexToAddress(router) || new(big.Int).SetBytes(data[36:68]).String() != "123456789" {
		t.Fatal("approval did not use exact required amount")
	}
	next := prepare(t, h, &quotev1.PrepareExecutionRequest{PreparationId: first.PreparationId})
	if !proto.Equal(first.ApprovalTransaction, next.ApprovalTransaction) || first.ExpiresAtUnix != next.ExpiresAtUnix {
		t.Fatal("approval terms changed")
	}
	if repeated := prepare(t, h, r); repeated.Status != quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED || !proto.Equal(first.ApprovalTransaction, repeated.ApprovalTransaction) {
		t.Fatal("prepare then execute lost approval quote")
	}
	*allowance = 123456789
	next = prepare(t, h, &quotev1.PrepareExecutionRequest{PreparationId: first.PreparationId})
	if next.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED || next.Message != "Approval state changed; request a fresh quote." || next.Transaction != nil || next.ApprovalTransaction != nil || *count != 0 {
		t.Fatal("old approval preparation became executable")
	}
	if prepare(t, h, r).Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("old quote reused after approval")
	}
}

func TestPreparationValidationExpiryAndSimulationFailure(t *testing.T) {
	for _, mutate := range []func(*quotev1.PrepareExecutionRequest){func(r *quotev1.PrepareExecutionRequest) { r.Sender = "0x00" }, func(r *quotev1.PrepareExecutionRequest) { r.Sender = "0x0000000000000000000000000000000000000000" }, func(r *quotev1.PrepareExecutionRequest) { r.SlippageBps = 10000 }, func(r *quotev1.PrepareExecutionRequest) { r.PreparationId = "p" }, func(r *quotev1.PrepareExecutionRequest) { r.RouteId = "wrong" }} {
		h, r, _, _, _ := executionFixture(t)
		mutate(r)
		_, err := h.PrepareExecution(context.Background(), connect.NewRequest(r))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("%v", err)
		}
	}
	h, r, _, _, _ := executionFixture(t)
	q := h.Store.quotes["q"]
	q.expires = time.Now()
	h.Store.quotes["q"] = q
	if prepare(t, h, r).Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("stale quote accepted")
	}
	h, r, _, _, _ = executionFixture(t)
	h.Simulator = simulationFake(func(context.Context, *quotev1.UnsignedTransaction, *quotev1.RouteQuote, rpc.Snapshot, *big.Int, *big.Int) (string, error) {
		return "", errors.New("secret")
	})
	failed := prepare(t, h, r)
	if failed.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED || failed.Transaction != nil || failed.Message == "secret" {
		t.Fatal("simulation failure not closed")
	}
	h, r, _, _, _ = executionFixture(t)
	ready := prepare(t, h, r)
	p := h.Store.preparations[ready.PreparationId]
	p.expires = time.Now()
	h.Store.preparations[ready.PreparationId] = p
	if prepare(t, h, &quotev1.PrepareExecutionRequest{PreparationId: ready.PreparationId}).Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("expired preparation accepted")
	}
	h.Store = NewStore()
	if prepare(t, h, r).Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("restart retained ID")
	}
}

func TestQuoteStoreClonesBoundsAndConcurrentAccess(t *testing.T) {
	s := NewStore()
	var wait sync.WaitGroup
	for worker := range 4 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for i := range 300 {
				f := &quotev1.QuoteFinal{QuoteId: strconv.Itoa(worker*300 + i)}
				s.saveQuote(&quotev1.QuoteRequest{AmountInAtomic: "17"}, f, time.Now())
				f.QuoteId = "mutated"
			}
		}()
	}
	wait.Wait()
	if len(s.quotes) != storeLimit {
		t.Fatalf("retained %d", len(s.quotes))
	}
	for id, q := range s.quotes {
		if q.final.QuoteId != id {
			t.Fatal("stored caller-owned pointer")
		}
	}
	s.prune(time.Now().Add(retention))
	if len(s.quotes) != 0 {
		t.Fatal("expired quotes retained")
	}
}

func TestStoreLookupAndApprovalAreDetachedAndAtomic(t *testing.T) {
	s := NewStore()
	now := time.Now()
	s.saveQuote(&quotev1.QuoteRequest{AmountInAtomic: "37"}, &quotev1.QuoteFinal{QuoteId: "q", Routes: []*quotev1.RouteQuote{testRoute()}}, now)
	p := preparation{response: &quotev1.PrepareExecutionResponse{PreparationId: "p", Route: testRoute()}, transaction: &quotev1.UnsignedTransaction{Data: "0x1234"}, expires: now.Add(retention)}
	s.savePreparation(p)
	p.transaction.Data = "changed after save"
	p.response.Route.Legs[0].Pool = "changed after save"
	q, found, loaded, recheck := s.lookup("q", "p", now)
	if !found || !recheck || q.approvals != nil || loaded.transaction.Data != "0x1234" || loaded.response.Route.Legs[0].Pool != tokenA {
		t.Fatal("Store did not detach saved terms")
	}
	q.request.AmountInAtomic = "64"
	q.final.Routes[0].Legs[0].Pool = "changed after lookup"
	loaded.transaction.Data = "changed after lookup"
	loaded.response.Route.Legs[0].Pool = "changed after lookup"
	q, _, loaded, _ = s.lookup("q", "p", now)
	if q.request.AmountInAtomic != "37" || q.final.Routes[0].Legs[0].Pool != tokenA || loaded.transaction.Data != "0x1234" || loaded.response.Route.Legs[0].Pool != tokenA {
		t.Fatal("lookup exposed stored terms")
	}
	var wait sync.WaitGroup
	previous := make(chan bool, 32)
	for range 32 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			wasRequired, found := s.markApproval("q", "wallet+spender", true, now)
			if !found {
				t.Error("live quote disappeared")
			}
			previous <- wasRequired
			s.lookup("q", "p", now)
		}()
	}
	wait.Wait()
	close(previous)
	first := 0
	for wasRequired := range previous {
		if !wasRequired {
			first++
		}
	}
	if first != 1 {
		t.Fatalf("approval observation was not atomic: %d first writers", first)
	}
	if wasRequired, found := s.markApproval("q", "wallet+spender", false, now); !found || !wasRequired {
		t.Fatal("approval history lost when allowance became sufficient")
	}
	if _, found, _, recheck := s.lookup("q", "p", now.Add(retention-time.Nanosecond)); !found || !recheck {
		t.Fatal("terms expired before retention boundary")
	}
	if _, found, _, recheck := s.lookup("q", "p", now.Add(retention)); found || recheck {
		t.Fatal("terms survived retention boundary")
	}
	if _, found := s.markApproval("q", "wallet+spender", true, now.Add(retention)); found {
		t.Fatal("approval marking resurrected expired quote")
	}
}

type rejectedSimulation struct {
	simulationFake
	err error
}

func (s rejectedSimulation) SimulateAllocations(context.Context, *quotev1.UnsignedTransaction, []*quotev1.QuotedAllocation, map[string]string, rpc.Snapshot, *big.Int, *big.Int) (string, error) {
	return "", s.err
}

func TestSimulationMessagesAreSafeAndNeverReturnTransactions(t *testing.T) {
	for _, test := range []struct {
		err     error
		message string
	}{
		{errSimulationNotConfigured, "Simulation is not configured. Check the engine's Tenderly settings."},
		{errSimulationUnavailable, "Simulation service is unavailable; execution was not prepared."},
		{errSimulationTimeout, "Simulation timed out; execution was not prepared."},
		{errSimulationEvidence, "Simulation evidence is incomplete or does not match the requested call and block."},
		{errSimulationInputAmount, "Simulation did not consume the exact input amount."},
		{errSimulationMinimumOutput, "Simulation output is below the minimum."},
		{errSimulationProtectedBalance, "Simulation changed a balance that must be preserved."},
		{errSimulationAllowance, "Simulation left an executor-to-router allowance uncleared."},
		{errors.New("https://secret.example X-Access-Key=secret body=secret"), "swap simulation could not prove safe execution"},
		{errors.New("Simulation timed out; execution was not prepared."), "swap simulation could not prove safe execution"},
	} {
		for _, executor := range []bool{false, true} {
			for _, recheck := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/executor=%t/recheck=%t", test.message, executor, recheck), func(t *testing.T) {
					h, r, _, _, _ := executionFixture(t)
					if executor {
						h, r, _, _ = executorFixture(t)
					}
					if recheck {
						ready := prepare(t, h, r)
						if ready.Status != quotev1.PreparationStatus_PREPARATION_STATUS_READY {
							t.Fatal("test requires ready preparation")
						}
						r = &quotev1.PrepareExecutionRequest{PreparationId: ready.PreparationId}
					}
					wrapped := fmt.Errorf("https://secret.example X-Access-Key=secret body=secret: %w", test.err)
					h.Simulator = rejectedSimulation{err: wrapped, simulationFake: func(context.Context, *quotev1.UnsignedTransaction, *quotev1.RouteQuote, rpc.Snapshot, *big.Int, *big.Int) (string, error) {
						return "", wrapped
					}}
					got := prepare(t, h, r)
					if got.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED || got.Message != test.message || got.Transaction != nil || got.ApprovalTransaction != nil {
						t.Fatalf("unsafe simulation response: %v", got)
					}
				})
			}
		}
	}
}

func TestCanonicalFailureDoesNotClaimReorg(t *testing.T) {
	for _, stage := range []string{"quote", "simulation", "approval check"} {
		t.Run(stage, func(t *testing.T) {
			h, r, allowance, _, _ := executionFixture(t)
			if stage == "approval check" {
				*allowance = 0
			}
			chain := h.Chains["test"]
			reader := chain.Client.(executionFake)
			reader.canonical = func(_ context.Context, s rpc.Snapshot) error {
				if (stage == "quote") == (s.BlockNumber == "112230") {
					return errors.New("https://secret.example RPC unavailable")
				}
				return nil
			}
			chain.Client = reader
			h.Chains["test"] = chain
			got := prepare(t, h, r)
			if got.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED || got.Message != "The "+stage+" block could not be confirmed; request a fresh quote." || got.Transaction != nil || got.ApprovalTransaction != nil {
				t.Fatalf("canonical failure misdiagnosed: %v", got)
			}
		})
	}
}

func TestAllocationDiagnosticsPreserveStatusAndCallOrder(t *testing.T) {
	for _, total := range []bool{false, true} {
		h, r, _, calls := executorFixture(t)
		message := "Selected route is not supported by the configured executor."
		if total {
			r.Allocations[1].AmountInAtomic = "65"
			message = "Allocation inputs must sum to the quoted input amount."
		} else {
			r.Allocations[1].RouteId = "unknown"
		}
		got := prepare(t, h, r)
		if got.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED || got.Message != message || got.Transaction != nil || got.ApprovalTransaction != nil || *calls != 0 {
			t.Fatalf("allocation contract changed: %v", got)
		}
	}
	h, r, _, _, _ := executionFixture(t)
	r.RouteId = "unknown"
	got, err := h.PrepareExecution(context.Background(), connect.NewRequest(r))
	if got != nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("direct unknown route lost InvalidArgument")
	}
}

func TestPreparationStoreEvictsEarliestExpiry(t *testing.T) {
	s := NewStore()
	now := time.Now()
	for i := range storeLimit + 1 {
		s.savePreparation(preparation{response: &quotev1.PrepareExecutionResponse{PreparationId: strconv.Itoa(i)}, transaction: &quotev1.UnsignedTransaction{Data: "0xab"}, expires: now.Add(retention + time.Duration(i)*time.Second)})
	}
	if len(s.preparations) != storeLimit {
		t.Fatal("preparation limit changed")
	}
	if _, _, _, found := s.lookup("", "0", now); found {
		t.Fatal("oldest preparation not evicted")
	}
	if _, _, _, found := s.lookup("", "1", now); !found {
		t.Fatal("newer preparation evicted")
	}
	if _, _, _, found := s.lookup("", strconv.Itoa(storeLimit), now); !found {
		t.Fatal("latest preparation not saved")
	}
}
