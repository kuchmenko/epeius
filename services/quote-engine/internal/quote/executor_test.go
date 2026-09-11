package quote

import (
	"bytes"
	"context"
	"encoding/json"
	"math/big"
	"os"
	"strconv"
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

const executorAddress = "0x9999999999999999999999999999999999999999"
const pancakeAddress = "0x6666666666666666666666666666666666666666"

func TestExecutorIndependentCalldataVectors(t *testing.T) {
	var fixture struct {
		Vectors []struct {
			Name, TokenIn, TokenOut, AmountIn, MinAmountOut, Deadline, Calldata string
			Allocations                                                         []struct {
				Venue    int
				AmountIn string
				Hops     []struct {
					TokenOut string
					Fee      uint32
				}
			}
		}
	}
	raw, err := os.ReadFile("../../../../contracts/fixtures/executor-calldata.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, v := range fixture.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			chain := config.Chain{Executor: &config.Executor{UniswapDeployment: "uni", PancakeDeployment: "pan"}, Deployments: map[string]config.Deployment{"uni": {Kind: "uniswap-v3"}, "pan": {Kind: "pancake-v3"}}}
			p := &quotev1.PrepareExecutionResponse{TokenIn: v.TokenIn, TokenOut: v.TokenOut, AmountInAtomic: v.AmountIn, AmountOutMinimumAtomic: v.MinAmountOut}
			for _, a := range v.Allocations {
				route := &quotev1.RouteQuote{Provider: []string{"uniswap-v3", "pancake-v3"}[a.Venue], DeploymentId: []string{"uni", "pan"}[a.Venue]}
				input := v.TokenIn
				for _, hop := range a.Hops {
					route.Legs = append(route.Legs, &quotev1.RouteLeg{TokenIn: input, TokenOut: hop.TokenOut, Selector: &quotev1.RouteLeg_FeePips{FeePips: hop.Fee}})
					input = hop.TokenOut
				}
				p.Allocations = append(p.Allocations, &quotev1.QuotedAllocation{AmountInAtomic: a.AmountIn, Route: route})
			}
			deadline, _ := strconv.ParseUint(v.Deadline, 10, 64)
			encoded, err := executorData(chain, p, deadline)
			if err != nil || hexutil.Encode(encoded) != v.Calldata {
				t.Fatalf("encoding mismatch: %v", err)
			}
		})
	}
}

type executorReader struct{ executionFake }

func (executorReader) Code(context.Context, common.Address, common.Hash) ([]byte, error) {
	return []byte{1}, nil
}

type executorSimulation struct {
	call func(*quotev1.UnsignedTransaction, SimulationChecks, *big.Int, *big.Int)
}

func (s executorSimulation) Simulate(_ context.Context, tx *quotev1.UnsignedTransaction, a SimulationChecks, _ rpc.Snapshot, amount, minimum *big.Int) (string, error) {
	s.call(tx, a, amount, minimum)
	return "251", nil
}

func executorFixture(t *testing.T) (Handler, *quotev1.PrepareExecutionRequest, *uint64, *int) {
	t.Helper()
	allowance := uint64(101)
	quotes := 0
	uni := testRoute()
	uni.RouteId = "uni:3000"
	uni.LatencyMs = ^uint32(0)
	uni.Legs = []*quotev1.RouteLeg{{Pool: tokenA, TokenIn: tokenA, TokenOut: tokenC, Selector: &quotev1.RouteLeg_FeePips{FeePips: 3000}}}
	pan := testRoute()
	pan.RouteId, pan.DeploymentId, pan.Provider = "pan:0:middle:2500", "pan", "pancake-v3"
	pan.Legs[0].Pool, pan.Legs[1].Pool = tokenB, tokenC
	pan.Legs[0].Selector = &quotev1.RouteLeg_FeePips{FeePips: 0}
	pan.Legs[1].Selector = &quotev1.RouteLeg_FeePips{FeePips: 2500}
	read := executorReader{executionFake{readerFake: readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) {
		return rpc.Snapshot{ChainID: "11155111", BlockNumber: "112233", BlockHash: blockHash, Timestamp: 1777777000}, nil
	}, call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
		if hash != common.HexToHash(blockHash) {
			t.Fatal("read escaped pinned block")
		}
		sig := hexutil.Encode(data[:4])
		if to == common.HexToAddress(executorAddress) {
			value := router
			if bytes.Equal(data, crypto.Keccak256([]byte("pancakeRouter()"))[:4]) {
				value = pancakeAddress
			}
			return common.LeftPadBytes(common.HexToAddress(value).Bytes(), 32), nil
		}
		if sig == "0xdd62ed3e" {
			if common.BytesToAddress(data[36:68]) != common.HexToAddress(executorAddress) {
				t.Fatal("approval targets router instead of executor")
			}
			return uintWord(allowance), nil
		}
		if sig == "0x1698ee82" {
			pool := tokenA
			if to == common.HexToAddress(pancakeAddress) {
				pool = tokenB
				if common.BytesToAddress(data[4:36]) == common.HexToAddress(tokenB) {
					pool = tokenC
				}
			}
			return common.LeftPadBytes(common.HexToAddress(pool).Bytes(), 32), nil
		}
		if sig != "0xc6a5026a" {
			t.Fatalf("unexpected quote selector %s", sig)
		}
		input := new(big.Int).SetBytes(data[68:100]).Uint64()
		expectedIn := []uint64{37, 64, 131}[quotes%3]
		output := []uint64{79, 131, 173}[quotes%3]
		if input != expectedIn {
			t.Fatalf("quoted %d, want exact input %d", input, expectedIn)
		}
		quotes++
		return append(append(append(uintWord(output), uintWord(123)...), uintWord(1)...), uintWord(100)...), nil
	}}, canonical: func(context.Context, rpc.Snapshot) error { return nil }}}
	h := Handler{Store: NewStore(), Chains: map[string]Chain{"test": {ChainID: "11155111", Client: read, Config: config.Chain{ExecutionEnabled: true, Executor: &config.Executor{Address: executorAddress, UniswapDeployment: "uni", PancakeDeployment: "pan"}, Deployments: map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Router: router, Factory: router, Quoter: router}, "pan": {Kind: "pancake-v3", Router: pancakeAddress, Factory: pancakeAddress, Quoter: pancakeAddress}}}}}, Simulator: executorSimulation{call: func(tx *quotev1.UnsignedTransaction, a SimulationChecks, amount, minimum *big.Int) {
		if tx.To != executorAddress || amount.String() != "101" || minimum.String() != "250" || len(a.ClearAllowances) != 3 || a.Input != (BalanceProbe{tokenA, wallet}) || a.Output != (BalanceProbe{tokenC, wallet}) {
			t.Fatal("simulation plan differs from exact quote")
		}
	}}}
	h.Store.saveQuote(&quotev1.QuoteRequest{Chain: "test", ChainId: "11155111", TokenIn: tokenA, TokenOut: tokenC, AmountInAtomic: "101"}, &quotev1.QuoteFinal{QuoteId: "q", Routes: []*quotev1.RouteQuote{uni, pan}, Block: &quotev1.BlockContext{Number: "112230", Hash: blockHash}}, time.Now())
	return configuredHandler(h), &quotev1.PrepareExecutionRequest{QuoteId: "q", Sender: wallet, SlippageBps: 75, Allocations: []*quotev1.RouteAllocation{{RouteId: uni.RouteId, AmountInAtomic: "37"}, {RouteId: pan.RouteId, AmountInAtomic: "64"}}}, &allowance, &quotes
}

func TestUnavailableSecondQuoterDoesNotQuoteFirstAllocation(t *testing.T) {
	h, r, _, calls := executorFixture(t)
	chain := h.Chains["test"]
	delete(chain.Quoters, "pan")
	if _, err := quoteAllocations(context.Background(), chain, h.Store.quotes["q"], r.Allocations); err == nil || *calls != 0 {
		t.Fatal("unavailable second quoter reached first allocation RPC", err, *calls)
	}
}

func TestExecutorPreparationExactQuotesAggregateRoundingAndImmutableRecheck(t *testing.T) {
	h, r, _, quotes := executorFixture(t)
	original := proto.CloneOf(h.Store.quotes["q"].final)
	p := prepare(t, h, r)
	if p.Status != quotev1.PreparationStatus_PREPARATION_STATUS_READY || p.Route != nil || p.AmountOutMinimumAtomic != "250" || *quotes != 3 || p.Allocations[0].Route.AmountOutAtomic != "79" || p.Allocations[1].Route.AmountOutAtomic != "173" {
		t.Fatalf("unexpected preparation: %v", p)
	}
	if p.Allocations[0].Route.Block.Number != "112230" || !proto.Equal(p.Allocations[0].Route.Block, p.Allocations[1].Route.Block) || p.Allocations[0].Route.NetworkCostOutAtomic != nil {
		t.Fatal("allocation block or cost evidence changed")
	}
	if p.Allocations[0].Route.LatencyMs == ^uint32(0) {
		t.Fatal("allocation reused original full-input quote latency")
	}
	checked := prepare(t, h, &quotev1.PrepareExecutionRequest{PreparationId: p.PreparationId})
	if !proto.Equal(p, checked) || *quotes != 3 {
		t.Fatal("recheck re-quoted or mutated terms")
	}
	if !proto.Equal(original, h.Store.quotes["q"].final) {
		t.Fatal("allocation re-quote mutated original quote")
	}
}

func TestExecutorApprovalNeverUpgradesOldQuote(t *testing.T) {
	h, r, allowance, _ := executorFixture(t)
	*allowance = 0
	p := prepare(t, h, r)
	if p.Status != quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED || p.ApprovalSpender != executorAddress || p.Transaction != nil {
		t.Fatalf("bad approval: %v", p)
	}
	*allowance = 101
	if prepare(t, h, &quotev1.PrepareExecutionRequest{PreparationId: p.PreparationId}).Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("old preparation executable")
	}
	if prepare(t, h, r).Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED {
		t.Fatal("old quote executable")
	}
}

func TestExecutorInvalidAllocationsFailBeforeQuote(t *testing.T) {
	for _, mutate := range []func(*quotev1.PrepareExecutionRequest){
		func(r *quotev1.PrepareExecutionRequest) { r.Allocations[0].AmountInAtomic = "0" },
		func(r *quotev1.PrepareExecutionRequest) { r.Allocations[0].AmountInAtomic = "38" },
		func(r *quotev1.PrepareExecutionRequest) { r.Allocations[1] = nil },
		func(r *quotev1.PrepareExecutionRequest) { r.Allocations[1].AmountInAtomic = "064" },
		func(r *quotev1.PrepareExecutionRequest) {
			r.Allocations[1].AmountInAtomic = new(big.Int).Lsh(big.NewInt(1), 256).String()
		},
		func(r *quotev1.PrepareExecutionRequest) { r.Allocations[1].RouteId = "missing" },
		func(r *quotev1.PrepareExecutionRequest) { r.Allocations[1].RouteId = r.Allocations[0].RouteId },
		func(r *quotev1.PrepareExecutionRequest) { r.RouteId = "uni:3000" },
		func(r *quotev1.PrepareExecutionRequest) { r.PreparationId = "p" },
	} {
		h, r, _, quotes := executorFixture(t)
		mutate(r)
		p, err := h.PrepareExecution(context.Background(), connect.NewRequest(r))
		if err == nil && p.Msg.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED {
			t.Fatal("invalid plan accepted")
		}
		if *quotes != 0 {
			t.Fatal("invalid plan reached quoter")
		}
	}
}

func TestExecutorPreparationRejectsWrongRouterLinkAndMissingSimulator(t *testing.T) {
	for _, missingSimulator := range []bool{false, true} {
		h, r, _, _ := executorFixture(t)
		if missingSimulator {
			h.Simulator = nil
		} else {
			chain := h.Chains["test"]
			reader := chain.Client.(executorReader)
			original := reader.call
			reader.call = func(ctx context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
				if to == common.HexToAddress(executorAddress) {
					return common.LeftPadBytes(common.HexToAddress(tokenA).Bytes(), 32), nil
				}
				return original(ctx, to, data, hash)
			}
			chain.Client = reader
			h.Chains["test"] = chain
		}
		p := prepare(t, h, r)
		if p.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED || p.Transaction != nil || p.ApprovalTransaction != nil {
			t.Fatal("unverified executor accepted")
		}
	}
}

func TestExecutorAdmissionChecksSecondPathBeforeRPC(t *testing.T) {
	for name, mutate := range map[string]func(*Chain, *quotev1.RouteQuote){
		"other deployment same kind": func(c *Chain, r *quotev1.RouteQuote) {
			c.Config.Deployments["other"] = c.Config.Deployments["pan"]
			r.DeploymentId = "other"
		},
		"missing deployment":  func(c *Chain, _ *quotev1.RouteQuote) { delete(c.Config.Deployments, "pan") },
		"disabled deployment": func(c *Chain, _ *quotev1.RouteQuote) { c.DeploymentErrors = map[string]string{"pan": "disabled"} },
		"wrong kind": func(c *Chain, _ *quotev1.RouteQuote) {
			d := c.Config.Deployments["pan"]
			d.Kind = "uniswap-v3"
			c.Config.Deployments["pan"] = d
		},
		"nil leg": func(_ *Chain, r *quotev1.RouteQuote) { r.Legs[1] = nil },
		"tick spacing": func(_ *Chain, r *quotev1.RouteQuote) {
			r.Legs[1].Selector = &quotev1.RouteLeg_TickSpacing{TickSpacing: 10}
		},
		"fee limit": func(_ *Chain, r *quotev1.RouteQuote) {
			r.Legs[1].Selector = &quotev1.RouteLeg_FeePips{FeePips: 1000000}
		},
		"disconnected": func(_ *Chain, r *quotev1.RouteQuote) { r.Legs[1].TokenIn = tokenA },
		"wrong pair":   func(_ *Chain, r *quotev1.RouteQuote) { r.Legs[1].TokenOut = tokenB },
	} {
		t.Run(name, func(t *testing.T) {
			h, r, _, quotes := executorFixture(t)
			chain := h.Chains["test"]
			mutate(&chain, h.Store.quotes["q"].final.Routes[1])
			reader := chain.Client.(executorReader)
			reader.call = func(context.Context, common.Address, []byte, common.Hash) ([]byte, error) {
				t.Fatal("invalid plan made a contract call")
				return nil, nil
			}
			chain.Client = reader
			h.Chains["test"] = chain
			p := prepare(t, h, r)
			if p.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED || p.Transaction != nil || p.ApprovalTransaction != nil || *quotes != 0 {
				t.Fatal("invalid second path was not rejected before RPC")
			}
		})
	}
}

func TestExecutorRejectsMissingOrChangedPools(t *testing.T) {
	for _, pool := range []common.Address{{}, common.HexToAddress(wallet)} {
		h, r, _, _ := executorFixture(t)
		chain := h.Chains["test"]
		reader := chain.Client.(executorReader)
		original := reader.call
		reader.call = func(ctx context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
			if hexutil.Encode(data[:4]) == "0x1698ee82" {
				return poolResponse(pool), nil
			}
			return original(ctx, to, data, hash)
		}
		chain.Client = reader
		h.Chains["test"] = chain
		before := proto.CloneOf(h.Store.quotes["q"].final)
		p := prepare(t, h, r)
		if p.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED || p.Transaction != nil || p.ApprovalTransaction != nil || !proto.Equal(before, h.Store.quotes["q"].final) {
			t.Fatal("missing or changed pool accepted or original quote mutated")
		}
	}
}

func TestExecutorGetterRejectsNoncanonicalAddressWords(t *testing.T) {
	for _, size := range []int{31, 32, 33} {
		h, _, _, _ := executorFixture(t)
		chain := h.Chains["test"]
		reader := chain.Client.(executorReader)
		original := reader.call
		reader.call = func(ctx context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
			value, err := original(ctx, to, data, hash)
			if to == common.HexToAddress(executorAddress) {
				value = append(value, 0)[:size]
				if size == 32 {
					value[0] = 1
				}
			}
			return value, err
		}
		if err := verifyExecutor(context.Background(), reader, chain.Config, common.HexToHash(blockHash)); err == nil {
			t.Fatal("getter accepted wrong length or nonzero address padding")
		}
	}
}
