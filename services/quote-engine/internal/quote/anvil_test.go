package quote

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
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
