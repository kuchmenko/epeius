package quote

import (
	"context"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

func configuredHandler(h Handler) Handler {
	for id, chain := range h.Chains {
		h.Chains[id] = ConfigureChain(chain)
	}
	return h
}

type alternateQuoter struct{ calls atomic.Int32 }

func (q *alternateQuoter) Candidates(r *quotev1.QuoteRequest, block *quotev1.BlockContext) func(context.Context) (QuoteCandidate, bool) {
	ids := []string{"opaque-z", "opaque-a"}
	return func(ctx context.Context) (QuoteCandidate, bool) {
		if len(ids) == 0 || ctx.Err() != nil {
			return QuoteCandidate{}, false
		}
		id := ids[0]
		ids = ids[1:]
		return QuoteCandidate{ID: id, Quote: func(context.Context) (*quotev1.RouteQuote, error) {
			q.calls.Add(1)
			return &quotev1.RouteQuote{RouteId: id, DeploymentId: "alternate", Provider: "alternate", AmountOutAtomic: "203", Block: proto.CloneOf(block)}, nil
		}}, true
	}
}
func (*alternateQuoter) Verify(context.Context, common.Hash) error { return nil }
func (*alternateQuoter) Requote(context.Context, *quotev1.RouteQuote, *big.Int, *quotev1.BlockContext) (*quotev1.RouteQuote, error) {
	return nil, errors.New("unexpected requote")
}

type alternatePreparer struct {
	t                *testing.T
	builds, verifies int
	retained         executionPlan
}

func (s *alternatePreparer) Select(_ context.Context, _ storedQuote, _ *quotev1.PrepareExecutionRequest, r *quotev1.RouteQuote) (executionSelection, string) {
	if r.Provider != "alternate" || len(r.Legs) != 0 {
		s.t.Fatal("generic flow imposed V3 legs")
	}
	return executionSelection{route: r, output: big.NewInt(203)}, ""
}
func (s *alternatePreparer) Build(p *quotev1.PrepareExecutionResponse) (executionPlan, string) {
	s.builds++
	if p.AmountInAtomic != "37" || p.AmountOutMinimumAtomic != "201" || p.DeadlineUnix != "1120" {
		s.t.Fatal("economic terms changed", p)
	}
	s.retained = executionPlan{
		transaction: &quotev1.UnsignedTransaction{ChainId: "8453", From: wallet, To: router, Data: "0x010203", ValueAtomic: "0", GasLimit: "123456"},
		spender:     pancakeAddress,
		checks:      SimulationChecks{Input: BalanceProbe{tokenA, wallet}, Output: BalanceProbe{tokenC, wallet}, Preserve: []BalanceProbe{{tokenB, executorAddress}}, ClearAllowances: []AllowanceProbe{{tokenA, tokenB, pancakeAddress}}},
		verify: func(_ context.Context, _ Reader, hash common.Hash) string {
			if hash != common.HexToHash(blockHash) {
				s.t.Fatal("verification not pinned")
			}
			s.verifies++
			return ""
		},
	}
	// A builder may retain its inputs; they cannot alias the stored response.
	p.AmountInAtomic = "999"
	return s.retained, ""
}

func TestAlternateImplementationFromConfigThroughImmutablePreparation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "epeius.toml")
	text := `[terminal]
default_chain = "base"
engine_url = "http://localhost:8090"
search_budget_ms = 1000
[engine]
listen_addr = "127.0.0.1:8090"
quote_concurrency = 2
[chains.base]
chain_id = 8453
rpc_url_env = "TEST_RPC"
execution_enabled = true
tokens = [{address = "` + tokenA + `", symbol = "A", decimals = 18}, {address = "` + tokenC + `", symbol = "C", decimals = 6}]
[chains.base.deployments.alternate]
kind = "alternate"
`
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(path, config.ValidateChain); err == nil {
		t.Fatal("shipped composition admitted an unknown protocol")
	}
	cfg, err := config.Load(path, func(c config.Chain) error {
		if len(c.Deployments) != 1 || c.Deployments["alternate"].Kind != "alternate" {
			return errors.New("unknown alternate deployment")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, approval := range []bool{false, true} {
		t.Run(map[bool]string{false: "ready", true: "approval"}[approval], func(t *testing.T) {
			q := &alternateQuoter{}
			s := &alternatePreparer{t: t}
			reader := executionFake{readerFake: readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) {
				return rpc.Snapshot{ChainID: "8453", BlockNumber: "9", BlockHash: blockHash, Timestamp: 1000}, nil
			}, call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
				if to != common.HexToAddress(tokenA) || hash != common.HexToHash(blockHash) || hexutil.Encode(data[:4]) != "0xdd62ed3e" || common.BytesToAddress(data[36:]) != common.HexToAddress(pancakeAddress) {
					t.Fatal("allowance used target rather than independent spender")
				}
				if approval {
					return uintWord(0), nil
				}
				return uintWord(37), nil
			}}, canonical: func(context.Context, rpc.Snapshot) error { return nil }}
			chain := Chain{ChainID: "8453", Config: cfg.Chains["base"], Client: reader, Quoters: map[string]ProtocolQuoter{"alternate": q}, Preparers: map[string]PreparationStrategy{"alternate": s}}
			unknown := ConfigureChain(chain)
			if unknown.Quoters["alternate"] != nil || unknown.Preparers["alternate"] != nil {
				t.Fatal("unknown runtime implementation admitted")
			}
			simulations := 0
			wantChecks := SimulationChecks{Input: BalanceProbe{tokenA, wallet}, Output: BalanceProbe{tokenC, wallet}, Preserve: []BalanceProbe{{tokenB, executorAddress}}, ClearAllowances: []AllowanceProbe{{tokenA, tokenB, pancakeAddress}}}
			h := Handler{Chains: map[string]Chain{"base": chain}, Store: NewStore(), QuoteConcurrency: 2, Simulator: simulationFake(func(_ context.Context, tx *quotev1.UnsignedTransaction, checks SimulationChecks, _ rpc.Snapshot, amount, minimum *big.Int) (string, error) {
				simulations++
				if !reflect.DeepEqual(checks, wantChecks) || tx.Data != "0x010203" || amount.String() != "37" || minimum.String() != "201" {
					t.Fatal("simulation terms reconstructed or mutated")
				}
				checks.Preserve[0].Owner = tokenA
				tx.Data = "mutated by simulator"
				return "203", nil
			})}
			quote, err := h.GetQuote(context.Background(), connect.NewRequest(&quotev1.QuoteRequest{Chain: "base", ChainId: "8453", TokenIn: tokenA, TokenOut: tokenC, AmountInAtomic: "37", SearchBudgetMs: 1000}))
			if err != nil {
				t.Fatal(err)
			}
			if quote.Msg.GetBestRouteId() != "opaque-z" || len(quote.Msg.Routes) != 2 || quote.Msg.Routes[1].RouteId != "opaque-a" || q.calls.Load() != 2 {
				t.Fatal("opaque enumeration/tie order changed", quote.Msg)
			}
			first, err := h.PrepareExecution(context.Background(), connect.NewRequest(&quotev1.PrepareExecutionRequest{QuoteId: quote.Msg.QuoteId, RouteId: "opaque-z", Sender: wallet, SlippageBps: 75}))
			if err != nil {
				t.Fatal(err)
			}
			if approval {
				if first.Msg.Status != quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED || first.Msg.Transaction != nil || first.Msg.ApprovalSpender != pancakeAddress {
					t.Fatal(first.Msg)
				}
				data, _ := hexutil.Decode(first.Msg.ApprovalTransaction.Data)
				if common.BytesToAddress(data[4:36]) != common.HexToAddress(pancakeAddress) {
					t.Fatal("approval encoded target")
				}
			} else if first.Msg.Status != quotev1.PreparationStatus_PREPARATION_STATUS_READY || first.Msg.Transaction.Data != "0x010203" || first.Msg.ApprovalTransaction != nil {
				t.Fatal(first.Msg)
			}
			s.retained.transaction.Data = "changed after build"
			s.retained.checks.Preserve[0].Owner = tokenA
			s.retained.checks.ClearAllowances[0].Spender = tokenA
			chain.Preparers = nil
			chain.Quoters = nil
			h.Chains["base"] = chain
			second, err := h.PrepareExecution(context.Background(), connect.NewRequest(&quotev1.PrepareExecutionRequest{PreparationId: first.Msg.PreparationId}))
			if err != nil || !proto.Equal(first.Msg, second.Msg) || s.builds != 1 || s.verifies != 2 || q.calls.Load() != 2 {
				t.Fatal("recheck rebuilt plan", err, second)
			}
			if (!approval && simulations != 2) || (approval && simulations != 0) {
				t.Fatal("simulation sequence changed")
			}
		})
	}
}
