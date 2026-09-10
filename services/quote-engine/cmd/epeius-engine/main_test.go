package main

import (
	"bytes"
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
)

func configFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "epeius.toml")
	text := `[terminal]
default_chain = "base"
engine_url = "http://127.0.0.1:8080"
search_budget_ms = 1000
[engine]
listen_addr = "127.0.0.1:0"
quote_concurrency = 4
[chains.z-test]
chain_id = 84532
rpc_url_env = "TEST_RPC"
[chains.base]
chain_id = 8453
rpc_url_env = "BASE_RPC"
`
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHelpDoesNotLoadConfig(t *testing.T) {
	var output bytes.Buffer
	if err := run(context.Background(), []string{"chains", "--config", "/missing", "--help"}, nil, &output); err != nil || !strings.Contains(output.String(), "chain check") {
		t.Fatalf("output=%q error=%v", output.String(), err)
	}
}

func TestChainsIsSortedAndDoesNotConnect(t *testing.T) {
	var output bytes.Buffer
	getenv := func(name string) string {
		if name == "BASE_RPC" {
			return "configured-but-never-opened"
		}
		return ""
	}
	if err := run(context.Background(), []string{"chains", "--config", configFile(t)}, getenv, &output); err != nil {
		t.Fatal(err)
	}
	want := `{"chains":[{"key":"base","chainId":"8453","rpcUrlEnv":"BASE_RPC","rpcConfigured":true},{"key":"z-test","chainId":"84532","rpcUrlEnv":"TEST_RPC","rpcConfigured":false}]}` + "\n"
	if output.String() != want {
		t.Fatalf("output=%q", output.String())
	}
}

func TestUnknownChainCheckPrintsStatusAndFails(t *testing.T) {
	var output bytes.Buffer
	err := run(context.Background(), []string{"chain", "check", "missing", "--config", configFile(t)}, func(string) string { return "" }, &output)
	if err == nil || err.Error() != "unknown chain" || !strings.Contains(output.String(), `"key":"missing"`) {
		t.Fatalf("output=%q error=%v", output.String(), err)
	}
}

func TestOpenChainsChecksInParallelAndKeepsClientsSeparate(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	server := func(id string, block int64) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				ID     json.RawMessage
				Method string
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Error(err)
				return
			}
			var result any = &types.Header{Number: big.NewInt(block), Difficulty: big.NewInt(0)}
			if req.Method == "eth_chainId" {
				entered <- struct{}{}
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				result = id
			}
			json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		}))
	}
	first, second := server("0x14a34", 17), server("0x2105", 93)
	defer first.Close()
	defer second.Close()
	go func() {
		defer close(release)
		for range 2 {
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Error("chain checks were not started in parallel")
				return
			}
		}
	}()
	chains := openChains(context.Background(), map[string]config.Chain{
		"alpha": {ChainID: 84532, RPCURLEnv: "FIRST"},
		"beta":  {ChainID: 8453, RPCURLEnv: "SECOND"},
	}, func(key string) string {
		if key == "FIRST" {
			return first.URL
		}
		return second.URL
	})
	defer closeChains(chains)
	for key, block := range map[string]string{"alpha": "17", "beta": "93"} {
		chain := chains[key]
		if chain.Client == nil {
			t.Fatalf("%s failed: %s", key, chain.Error)
		}
		snapshot, err := chain.Client.Snapshot(context.Background())
		if err != nil || snapshot.BlockNumber != block || snapshot.ChainID != chain.ChainID {
			t.Fatalf("%s used the wrong client: %+v, %v", key, snapshot, err)
		}
	}
}
