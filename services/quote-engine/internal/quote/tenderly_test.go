package quote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTenderlyExecutorVerifiesEveryTouchedTokenOwner(t *testing.T) {
	const tokenD = "0x4444444444444444444444444444444444444444"
	uni, pan := testRoute(), testRoute()
	pan.DeploymentId = "pan"
	pan.Legs[0].TokenOut, pan.Legs[1].TokenIn = tokenD, tokenD
	allocations := []*quotev1.QuotedAllocation{{AmountInAtomic: "37", Route: uni}, {AmountInAtomic: "64", Route: pan}}
	expected := []balanceProbe{
		{tokenA, wallet}, {tokenC, wallet},
		{tokenA, executorAddress}, {tokenA, router},
		{tokenB, wallet}, {tokenB, executorAddress}, {tokenB, router},
		{tokenC, executorAddress}, {tokenC, router}, {tokenA, pancakeAddress},
		{tokenD, wallet}, {tokenD, executorAddress}, {tokenD, pancakeAddress}, {tokenC, pancakeAddress},
	}
	allowances := []balanceProbe{{tokenA, router}, {tokenB, router}, {tokenA, pancakeAddress}, {tokenD, pancakeAddress}}
	for changed := -1; changed < len(expected)+len(allowances); changed++ {
		service := NewTenderly(func(string) string { return "test" })
		service.client.Transport = roundTrip(func(request *http.Request) (*http.Response, error) {
			var payload struct {
				Simulations []simulationCall `json:"simulations"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			count := len(expected)
			if len(payload.Simulations) != count*2+1+len(allowances) {
				t.Fatal("missing executor token-owner evidence")
			}
			results := make([]simulationResult, len(payload.Simulations))
			for i, call := range payload.Simulations {
				value := uint64(1000)
				if call.TransactionIndex != -1 || call.From != wallet || call.NetworkID != "11155111" || call.BlockNumber != 112233 {
					t.Fatal("simulation identity changed")
				}
				if i > count*2 {
					index := i - count*2 - 1
					probe := allowances[index]
					data, _ := hexutil.Decode(call.Input)
					if call.To != probe.token || len(data) != 68 || hexutil.Encode(data[:4]) != "0xdd62ed3e" || common.BytesToAddress(data[4:36]) != common.HexToAddress(executorAddress) || common.BytesToAddress(data[36:]) != common.HexToAddress(probe.owner) {
						t.Fatal("wrong cleared-allowance probe")
					}
					value = 0
					if changed == count+index {
						value = 1
					}
				} else if i == count {
					if call.To != executorAddress || call.Input != "0x19b5e3d5abcd" {
						t.Fatal("not exact executor transaction")
					}
				} else {
					index := i
					if i > count {
						index -= count + 1
					}
					data, _ := hexutil.Decode(call.Input)
					if call.To != expected[index].token || len(data) != 36 || common.BytesToAddress(data[4:]) != common.HexToAddress(expected[index].owner) {
						t.Fatal("wrong token-owner probe")
					}
					if i > count {
						if index == 0 {
							value = 899
						}
						if index == 1 {
							value = 1252
						}
						if index == changed {
							value--
						}
					}
				}
				identity := simulationIdentity{NetworkID: call.NetworkID, BlockNumber: call.BlockNumber, From: call.From, To: call.To, Input: call.Input, Value: "0", Status: true}
				results[i].Simulation.simulationIdentity = identity
				results[i].Transaction.simulationIdentity = identity
				results[i].Simulation.TransactionIndex = -1
				results[i].Simulation.BlockHeader.Number = "0x1b669"
				results[i].Simulation.BlockHeader.Hash = blockHash
				results[i].Simulation.BlockHeader.Timestamp = "0x4321"
				trace := &results[i].Transaction.TransactionInfo.CallTrace
				trace.From, trace.To, trace.Input, trace.Output = call.From, call.To, call.Input, hexutil.Encode(uintWord(value))
			}
			body, _ := json.Marshal(map[string]any{"simulation_results": results})
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})
		output, err := service.SimulateAllocations(context.Background(), &quotev1.UnsignedTransaction{ChainId: "11155111", From: wallet, To: executorAddress, Data: "0x19b5e3d5abcd", ValueAtomic: "0", GasLimit: "3000000"}, allocations, map[string]string{"uni": router, "pan": pancakeAddress}, rpc.Snapshot{ChainID: "11155111", BlockNumber: "112233", BlockHash: blockHash, Timestamp: 0x4321}, big.NewInt(101), big.NewInt(252))
		if changed == -1 && (err != nil || output != "252") {
			t.Fatalf("valid executor simulation failed: %v", err)
		}
		if changed >= 0 {
			want := errSimulationProtectedBalance
			switch {
			case changed == 0:
				want = errSimulationInputAmount
			case changed == 1:
				want = errSimulationMinimumOutput
			case changed >= len(expected):
				want = errSimulationAllowance
			}
			if !errors.Is(err, want) || output != "" {
				t.Fatalf("changed probe %d: output=%q err=%v, want %v", changed, output, err, want)
			}
		}
	}
}

func TestTenderlySequentialBundleExactBalancesAndFailClosed(t *testing.T) {
	tests := []struct {
		name   string
		mutate func([]simulationResult)
		want   error
	}{
		{"exact deltas", func([]simulationResult) {}, nil},
		{"partial input consumption", func(r []simulationResult) {
			r[4].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(890))
		}, errSimulationInputAmount},
		{"excess input consumption", func(r []simulationResult) {
			r[4].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(888))
		}, errSimulationInputAmount},
		{"output below minimum", func(r []simulationResult) {
			r[5].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(236))
		}, errSimulationMinimumOutput},
		{"output at minimum", func(r []simulationResult) {
			r[5].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(237))
		}, nil},
		{"new router residue", func(r []simulationResult) {
			r[6].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(10))
		}, errSimulationProtectedBalance},
		{"consumed old router residue", func(r []simulationResult) {
			r[6].Transaction.TransactionInfo.CallTrace.Output = hexutil.Encode(uintWord(8))
		}, errSimulationProtectedBalance},
		{"missing output", func(r []simulationResult) { r[0].Transaction.TransactionInfo.CallTrace.Output = "" }, errSimulationEvidence},
		{"wrong wallet", func(r []simulationResult) { r[3].Simulation.From = tokenA }, errSimulationEvidence},
		{"wrong trace wallet", func(r []simulationResult) { r[1].Transaction.TransactionInfo.CallTrace.From = tokenB }, errSimulationEvidence},
		{"wrong network", func(r []simulationResult) { r[4].Transaction.NetworkID = "8453" }, errSimulationEvidence},
		{"wrong block number", func(r []simulationResult) { r[5].Simulation.BlockNumber++ }, errSimulationEvidence},
		{"start of block despite matching hash", func(r []simulationResult) { r[0].Simulation.TransactionIndex = 0 }, errSimulationEvidence},
		{"mid-block swap despite matching hash", func(r []simulationResult) { r[3].Simulation.TransactionIndex = 22 }, errSimulationEvidence},
		{"post-probe lost end-block index", func(r []simulationResult) { r[6].Simulation.TransactionIndex = 0 }, errSimulationEvidence},
		{"wrong block hash", func(r []simulationResult) { r[2].Simulation.BlockHeader.Hash = common.Hash{}.Hex() }, errSimulationEvidence},
		{"missing block header", func(r []simulationResult) { r[3].Simulation.BlockHeader.Number = "" }, errSimulationEvidence},
		{"wrong timestamp", func(r []simulationResult) { r[6].Simulation.BlockHeader.Timestamp = "0x4322" }, errSimulationEvidence},
		{"wrong calldata", func(r []simulationResult) { r[3].Transaction.Input = "0x" }, errSimulationEvidence},
		{"secret upstream trace error", func(r []simulationResult) {
			r[3].Transaction.TransactionInfo.CallTrace.Error = "private-test-value https://secret.example"
		}, errSimulationEvidence},
	}
	for step := range 7 {
		for _, where := range []string{"simulation", "transaction"} {
			tests = append(tests, struct {
				name   string
				mutate func([]simulationResult)
				want   error
			}{name: where + string(rune('0'+step)) + " failed", want: errSimulationEvidence, mutate: func(r []simulationResult) {
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
			if test.want != nil {
				if !errors.Is(err, test.want) || err.Error() != test.want.Error() || output != "" {
					t.Fatalf("output=%q err=%v, want %v", output, err, test.want)
				}
			} else {
				wantOutput := "203"
				if test.name == "output at minimum" {
					wantOutput = "200"
				}
				if err != nil || output != wantOutput {
					t.Fatalf("output=%q err=%v", output, err)
				}
			}
		})
	}
}

func TestTenderlyTransportErrorsAreSanitized(t *testing.T) {
	const secret = "planted-secret"
	for _, test := range []struct {
		mode string
		want error
	}{
		{"network", errSimulationUnavailable},
		{"http", errSimulationUnavailable},
		{"deadline", errSimulationTimeout},
		{"network timeout", errSimulationTimeout},
		{"canceled", errSimulationUnavailable},
		{"json", errSimulationEvidence},
		{"missing", errSimulationEvidence},
		{"body timeout", errSimulationTimeout},
		{"body error", errSimulationEvidence},
	} {
		t.Run(test.mode, func(t *testing.T) {
			service := NewTenderly(func(string) string { return secret })
			requests := 0
			service.client.Transport = roundTrip(func(request *http.Request) (*http.Response, error) {
				requests++
				if !strings.Contains(request.URL.String(), secret) || request.Header.Get("X-Access-Key") != secret {
					t.Fatal("test must exercise secret request URL and header")
				}
				status := http.StatusOK
				var body io.Reader = strings.NewReader(secret)
				switch test.mode {
				case "network":
					return nil, &url.Error{Op: "Post", URL: "https://" + secret + ".example", Err: errors.New(secret)}
				case "http":
					status = http.StatusUnauthorized
				case "deadline":
					return nil, fmt.Errorf("%s: %w", secret, context.DeadlineExceeded)
				case "network timeout":
					return nil, &url.Error{Op: secret, URL: "https://" + secret + ".example", Err: os.ErrDeadlineExceeded}
				case "canceled":
					return nil, fmt.Errorf("%s: %w", secret, context.Canceled)
				case "missing":
					body = strings.NewReader(`{"simulation_results":[], "error":"` + secret + `"}`)
				case "body timeout":
					body = iotest.ErrReader(fmt.Errorf("%s: %w", secret, context.DeadlineExceeded))
				case "body error":
					body = iotest.ErrReader(errors.New(secret))
				}
				return &http.Response{StatusCode: status, Header: http.Header{"X-Upstream-Error": {secret}}, Body: io.NopCloser(body)}, nil
			})
			output, err := service.Simulate(context.Background(), &quotev1.UnsignedTransaction{ChainId: "84532", From: wallet, To: router, Data: "0x", ValueAtomic: "0", GasLimit: "1500000"}, testRoute(), rpc.Snapshot{ChainID: "84532", BlockNumber: "1"}, big.NewInt(1), big.NewInt(1))
			if !errors.Is(err, test.want) || err.Error() != test.want.Error() || strings.Contains(err.Error(), secret) || output != "" {
				t.Fatalf("output=%q err=%v, want only %v", output, err, test.want)
			}
			if requests != 1 {
				t.Fatalf("made %d requests; expected no retries", requests)
			}
		})
	}
}

func TestTenderlyConfigurationAndInvalidRequestAreDistinct(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Tenderly, *quotev1.UnsignedTransaction, *rpc.Snapshot)
		config bool
	}{
		{"missing key", func(s *Tenderly, _ *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { s.key = "" }, true},
		{"missing account", func(s *Tenderly, _ *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { s.account = "" }, true},
		{"invalid account", func(s *Tenderly, _ *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { s.account = "secret/account" }, true},
		{"missing project", func(s *Tenderly, _ *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { s.project = "" }, true},
		{"invalid project", func(s *Tenderly, _ *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { s.project = "secret?project" }, true},
		{"invalid chain", func(_ *Tenderly, tx *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { tx.ChainId = "secret" }, false},
		{"wrong chain", func(_ *Tenderly, tx *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { tx.ChainId = "1" }, false},
		{"nonzero value", func(_ *Tenderly, tx *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { tx.ValueAtomic = "1" }, false},
		{"invalid block", func(_ *Tenderly, _ *quotev1.UnsignedTransaction, s *rpc.Snapshot) { s.BlockNumber = "secret" }, false},
		{"invalid gas", func(_ *Tenderly, tx *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { tx.GasLimit = "secret" }, false},
		{"zero gas", func(_ *Tenderly, tx *quotev1.UnsignedTransaction, _ *rpc.Snapshot) { tx.GasLimit = "0" }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := NewTenderly(func(string) string { return "secret" })
			service.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
				t.Fatal("invalid configuration or request must not reach transport")
				return nil, errors.New("unexpected transport")
			})
			tx := &quotev1.UnsignedTransaction{ChainId: "84532", From: wallet, To: router, Data: "0x", ValueAtomic: "0", GasLimit: "1500000"}
			snapshot := rpc.Snapshot{ChainID: "84532", BlockNumber: "1"}
			test.mutate(service, tx, &snapshot)
			output, err := service.Simulate(context.Background(), tx, testRoute(), snapshot, big.NewInt(1), big.NewInt(1))
			want := "simulation verification failed"
			if test.config {
				want = "Simulation is not configured. Check the engine's Tenderly settings."
			}
			if err == nil || err.Error() != want || errors.Is(err, errSimulationNotConfigured) != test.config || output != "" {
				t.Fatalf("output=%q err=%v, want %q", output, err, want)
			}
		})
	}
}

func TestTenderlyIndependentJSONFixture(t *testing.T) {
	// Hand-authored, sanitized wire fixture, independent of simulationResult and
	// request serialization. Wallet input: 1000 - 889 = 111; output: 240 - 37 = 203.
	const fixture = `{"simulation_results":[
  {
    "simulation": {
      "network_id":"11155111", "block_number":112233, "transaction_index":-1,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x1111111111111111111111111111111111111111",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0", "status":true,
      "block_header":{"number":"0x1b669", "hash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "timestamp":"0x4321"}
    },
    "transaction": {
      "network_id":"11155111", "block_number":112233,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x1111111111111111111111111111111111111111",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0x0", "status":true,
      "transaction_info":{"call_trace":{
        "from":"0x7777777777777777777777777777777777777777", "to":"0x1111111111111111111111111111111111111111",
        "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777",
        "output":"0x00000000000000000000000000000000000000000000000000000000000003e8", "error":""
      }}
    }
  },
  {
    "simulation": {
      "network_id":"11155111", "block_number":112233, "transaction_index":-1,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x3333333333333333333333333333333333333333",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0", "status":true,
      "block_header":{"number":"0x1b669", "hash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "timestamp":"0x4321"}
    },
    "transaction": {
      "network_id":"11155111", "block_number":112233,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x3333333333333333333333333333333333333333",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0", "status":true,
      "transaction_info":{"call_trace":{
        "from":"0x7777777777777777777777777777777777777777", "to":"0x3333333333333333333333333333333333333333",
        "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777",
        "output":"0x0000000000000000000000000000000000000000000000000000000000000025", "error":""
      }}
    }
  },
  {
    "simulation": {
      "network_id":"11155111", "block_number":112233, "transaction_index":-1,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x8888888888888888888888888888888888888888",
      "input":"0xaabbccdd", "value":"0", "status":true,
      "block_header":{"number":"0x1b669", "hash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "timestamp":"0x4321"}
    },
    "transaction": {
      "network_id":"11155111", "block_number":112233,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x8888888888888888888888888888888888888888",
      "input":"0xaabbccdd", "value":"0x", "status":true,
      "transaction_info":{"call_trace":{
        "from":"0x7777777777777777777777777777777777777777", "to":"0x8888888888888888888888888888888888888888",
        "input":"0xaabbccdd", "output":"0x", "error":""
      }}
    }
  },
  {
    "simulation": {
      "network_id":"11155111", "block_number":112233, "transaction_index":-1,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x1111111111111111111111111111111111111111",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0", "status":true,
      "block_header":{"number":"0x1b669", "hash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "timestamp":"0x4321"}
    },
    "transaction": {
      "network_id":"11155111", "block_number":112233,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x1111111111111111111111111111111111111111",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0", "status":true,
      "transaction_info":{"call_trace":{
        "from":"0x7777777777777777777777777777777777777777", "to":"0x1111111111111111111111111111111111111111",
        "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777",
        "output":"0x0000000000000000000000000000000000000000000000000000000000000379", "error":""
      }}
    }
  },
  {
    "simulation": {
      "network_id":"11155111", "block_number":112233, "transaction_index":-1,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x3333333333333333333333333333333333333333",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0", "status":true,
      "block_header":{"number":"0x1b669", "hash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "timestamp":"0x4321"}
    },
    "transaction": {
      "network_id":"11155111", "block_number":112233,
      "from":"0x7777777777777777777777777777777777777777", "to":"0x3333333333333333333333333333333333333333",
      "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777", "value":"0", "status":true,
      "transaction_info":{"call_trace":{
        "from":"0x7777777777777777777777777777777777777777", "to":"0x3333333333333333333333333333333333333333",
        "input":"0x70a082310000000000000000000000007777777777777777777777777777777777777777",
        "output":"0x00000000000000000000000000000000000000000000000000000000000000f0", "error":""
      }}
    }
  }
]}`
	service := NewTenderly(func(string) string { return "test" })
	service.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(fixture))}, nil
	})
	route := &quotev1.RouteQuote{Legs: []*quotev1.RouteLeg{{TokenIn: tokenA, TokenOut: tokenC}}}
	output, err := service.Simulate(context.Background(), &quotev1.UnsignedTransaction{ChainId: "11155111", From: wallet, To: router, Data: "0xaabbccdd", ValueAtomic: "0", GasLimit: "1500000"}, route, rpc.Snapshot{ChainID: "11155111", BlockNumber: "112233", BlockHash: blockHash, Timestamp: 0x4321}, big.NewInt(111), big.NewInt(200))
	if err != nil || output != "203" {
		t.Fatalf("independent wire fixture: output=%q err=%v", output, err)
	}
}
