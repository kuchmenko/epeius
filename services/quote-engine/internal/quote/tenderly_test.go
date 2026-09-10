package quote

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTenderlySequentialBundleExactBalancesAndFailClosed(t *testing.T) {
	tests := []struct {
		name   string
		mutate func([]simulationResult)
		reject bool
	}{
		{"exact deltas", func([]simulationResult) {}, false},
		{"partial input consumption", func(r []simulationResult) {
			r[4].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(890))
		}, true},
		{"excess input consumption", func(r []simulationResult) {
			r[4].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(888))
		}, true},
		{"output below minimum", func(r []simulationResult) {
			r[5].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(236))
		}, true},
		{"new router residue", func(r []simulationResult) {
			r[6].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(10))
		}, true},
		{"consumed old router residue", func(r []simulationResult) {
			r[6].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(8))
		}, true},
		{"missing output", func(r []simulationResult) { r[0].Transaction.TransactionInfo.CallTrace.Output = "" }, true},
		{"wrong wallet", func(r []simulationResult) { r[3].Simulation.From = tokenA }, true},
		{"wrong trace wallet", func(r []simulationResult) { r[1].Transaction.TransactionInfo.CallTrace.From = tokenB }, true},
		{"wrong network", func(r []simulationResult) { r[4].Transaction.NetworkID = "8453" }, true},
		{"wrong block number", func(r []simulationResult) { r[5].Simulation.BlockNumber++ }, true},
		{"start of block despite matching hash", func(r []simulationResult) { r[0].Simulation.TransactionIndex = 0 }, true},
		{"mid-block swap despite matching hash", func(r []simulationResult) { r[3].Simulation.TransactionIndex = 22 }, true},
		{"post-probe lost end-block index", func(r []simulationResult) { r[6].Simulation.TransactionIndex = 0 }, true},
		{"wrong block hash", func(r []simulationResult) { r[2].Simulation.BlockHeader.Hash = common.Hash{}.Hex() }, true},
		{"missing block header", func(r []simulationResult) { r[3].Simulation.BlockHeader.Number = "" }, true},
		{"wrong timestamp", func(r []simulationResult) { r[6].Simulation.BlockHeader.Timestamp = "0x4322" }, true},
		{"wrong calldata", func(r []simulationResult) { r[3].Transaction.Input = "0x" }, true},
	}
	for step := range 7 {
		for _, where := range []string{"simulation", "transaction"} {
			tests = append(tests, struct {
				name   string
				mutate func([]simulationResult)
				reject bool
			}{name: where + string(rune('0'+step)) + " failed", reject: true, mutate: func(r []simulationResult) {
				if where == "simulation" {
					r[step].Simulation.Status = false
				} else {
					r[step].Transaction.Status = false
				}
			}})
		}
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tenderly := NewTenderly(func(string) string { return "private-test-value" })
			tenderly.client.Transport = roundTrip(func(request *http.Request) (*http.Response, error) {
				if request.URL.Scheme != "https" || request.URL.Host != "api.tenderly.co" || request.Header.Get("X-Access-Key") != "private-test-value" {
					t.Fatal("endpoint or credentials changed")
				}
				if _, ok := request.Context().Deadline(); !ok {
					t.Fatal("missing timeout")
				}
				var payload struct {
					Simulations []simulationCall `json:"simulations"`
				}
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
					t.Fatal(err)
				}
				if len(payload.Simulations) != 7 {
					t.Fatal("missing pre/post probes")
				}
				outputs := []uint64{1000, 37, 9, 0, 889, 240, 9}
				results := make([]simulationResult, 7)
				for i, call := range payload.Simulations {
					if call.From != wallet || call.BlockNumber != 112233 || call.NetworkID != "11155111" || call.SimulationType != "full" || call.Save || call.SaveIfFails || call.Value != "0" || call.Gas != 1500000 {
						t.Fatalf("unsafe call: %+v", call)
					}
					if call.TransactionIndex != -1 {
						t.Fatal("every bundle step must explicitly use end-of-block state, not the default index zero")
					}
					if i == 3 {
						if call.To != router || call.Input != "0xaabbccdd" {
							t.Fatal("not exact swap")
						}
					} else {
						tokens := []string{tokenA, tokenC, tokenB}
						index := i
						if i > 3 {
							index = i - 4
						}
						owner := wallet
						if index == 2 {
							owner = router
						}
						data, _ := hexutil.Decode(call.Input)
						if call.To != tokens[index] || len(data) != 36 || hexutil.Encode(data[:4]) != "0x70a08231" || common.BytesToAddress(data[4:]) != common.HexToAddress(owner) {
							t.Fatal("incorrect balance probe")
						}
					}
					identity := simulationIdentity{NetworkID: call.NetworkID, BlockNumber: call.BlockNumber, From: call.From, To: call.To, Input: call.Input, Value: "0", Status: true}
					results[i].Simulation.simulationIdentity = identity
					results[i].Simulation.TransactionIndex = -1
					results[i].Transaction.simulationIdentity = identity
					results[i].Simulation.BlockHeader.Number = "0x1b669"
					results[i].Simulation.BlockHeader.Hash = blockHash
					results[i].Simulation.BlockHeader.Timestamp = "0x4321"
					trace := &results[i].Transaction.TransactionInfo.CallTrace
					trace.From = call.From
					trace.To = call.To
					trace.Input = call.Input
					trace.Output = hexutil.Encode(uintWord(outputs[i]))
				}
				test.mutate(results)
				body, _ := json.Marshal(map[string]any{"simulation_results": results})
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})
			output, err := tenderly.Simulate(context.Background(), &quotev1.UnsignedTransaction{ChainId: "11155111", From: wallet, To: router, Data: "0xaabbccdd", ValueAtomic: "0", GasLimit: "1500000"}, testRoute(), rpc.Snapshot{ChainID: "11155111", BlockNumber: "112233", BlockHash: blockHash, Timestamp: 0x4321}, big.NewInt(111), big.NewInt(200))
			if test.reject {
				if err == nil || output != "" {
					t.Fatal("unsafe simulation accepted")
				}
			} else if err != nil || output != "203" {
				t.Fatalf("output=%q err=%v", output, err)
			}
		})
	}
}

func TestTenderlyTransportErrorsAreSanitized(t *testing.T) {
	for _, mode := range []string{"network", "http", "json", "missing"} {
		t.Run(mode, func(t *testing.T) {
			service := NewTenderly(func(string) string { return "secret" })
			service.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
				if mode == "network" {
					return nil, errors.New("secret upstream")
				}
				status := 200
				body := "secret"
				if mode == "http" {
					status = 401
				}
				if mode == "missing" {
					body = `{"simulation_results":[]}`
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			_, err := service.Simulate(context.Background(), &quotev1.UnsignedTransaction{ChainId: "84532", From: wallet, To: router, Data: "0x", ValueAtomic: "0", GasLimit: "1500000"}, testRoute(), rpc.Snapshot{ChainID: "84532", BlockNumber: "1"}, big.NewInt(1), big.NewInt(1))
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatal("transport error leaked or accepted")
			}
		})
	}
}
