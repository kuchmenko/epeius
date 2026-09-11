package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

func Verify(ctx context.Context, key string, chainID int64, endpoint string) (Snapshot, error) {
	client, snapshot, err := Open(ctx, key, chainID, endpoint)
	if client != nil {
		client.Close()
	}
	return snapshot, err
}

func TestPinnedCall(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(strconv.FormatBool(fail), func(t *testing.T) {
			calls := 0
			hash := common.HexToHash("0x1234")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					ID     json.RawMessage
					Method string
					Params []json.RawMessage
				}
				json.NewDecoder(r.Body).Decode(&request)
				calls++
				if request.Method != "eth_call" || len(request.Params) != 2 {
					t.Error("unexpected RPC call")
					return
				}
				var block struct {
					BlockHash        string
					RequireCanonical bool
				}
				json.Unmarshal(request.Params[1], &block)
				if block.BlockHash != hash.Hex() || !block.RequireCanonical {
					t.Errorf("unpinned call: %s", request.Params[1])
				}
				var args map[string]string
				json.Unmarshal(request.Params[0], &args)
				if args["data"] != "0x010203" || common.HexToAddress(args["to"]) != common.HexToAddress("0xabcd") {
					t.Error(args)
				}
				response := map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": "0x0405"}
				if fail {
					delete(response, "result")
					response["error"] = map[string]any{"code": -32000, "message": "secret canonical block unavailable"}
				}
				json.NewEncoder(w).Encode(response)
			}))
			defer server.Close()
			eth, err := ethclient.Dial(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			client := &Client{Client: eth}
			defer client.Close()
			got, err := client.Call(context.Background(), common.HexToAddress("0xabcd"), []byte{1, 2, 3}, hash)
			if fail {
				if err == nil || strings.Contains(err.Error(), "secret") {
					t.Fatal(err)
				}
			} else if err != nil || string(got) != string([]byte{4, 5}) {
				t.Fatalf("%x %v", got, err)
			}
			if calls != 1 {
				t.Fatal("must not retry at latest")
			}
		})
	}
}

func TestVerifyNetworksAndSnapshot(t *testing.T) {
	for _, tc := range []struct {
		key, chain, want string
		chainID          int64
	}{
		{"base", "0x2105", "8453", 8453}, {"test", "0x14a34", "84532", 84532},
	} {
		t.Run(tc.key, func(t *testing.T) {
			header := &types.Header{Number: big.NewInt(1234567), Difficulty: big.NewInt(0), GasLimit: 30000000, Time: 1700000013}
			methods := []string{}
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
				methods = append(methods, request.Method)
				var result any = tc.chain
				if request.Method == "eth_getBlockByNumber" {
					if string(request.Params[0]) != `"latest"` || string(request.Params[1]) != "false" {
						t.Error("unexpected block arguments")
					}
					result = header
				} else if request.Method != "eth_chainId" {
					t.Errorf("unexpected RPC: %s", request.Method)
				}
				json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			}))
			defer server.Close()
			got, err := Verify(context.Background(), tc.key, tc.chainID, server.URL)
			if err != nil {
				t.Fatal(err)
			}
			if got.Key != tc.key || got.ChainID != tc.want || got.BlockNumber != "1234567" || got.BlockHash != header.Hash().Hex() {
				t.Fatalf("wrong snapshot: %+v", got)
			}
			if strings.Join(methods, ",") != "eth_chainId,eth_getBlockByNumber" {
				t.Fatal(methods)
			}
		})
	}
}

func TestEndpointTransportPolicy(t *testing.T) {
	for _, tc := range []struct {
		endpoint string
		allowed  bool
	}{
		{"https://example.com/secret", true},
		{"http://127.0.0.1:8545/secret", true},
		{"http://127.0.0.2:8545/secret", true},
		{"http://[::1]:8545/secret", true},
		{"http://localhost:8545/secret", true},
		{"http://example.com/secret", false},
		{"http://192.168.1.2/secret", false},
		{"http://[2001:db8::1]/secret", false},
		{"http://localhost.example.com/secret", false},
		{"http://127.0.0.1.example.com/secret", false},
	} {
		t.Run(tc.endpoint, func(t *testing.T) {
			// Cancellation prevents network access after successful URL validation.
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			client, _, err := Open(ctx, "base", 8453, tc.endpoint)
			if client != nil {
				client.Close()
				t.Fatal("unexpected live client")
			}
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsafe error: %v", err)
			}
			if tc.allowed != errors.Is(err, context.Canceled) {
				t.Fatalf("allowed=%t: %v", tc.allowed, err)
			}
			if !tc.allowed && !strings.Contains(err.Error(), "HTTPS") {
				t.Fatalf("expected transport rejection: %v", err)
			}
		})
	}
}

func TestRejectInvalidEndpoint(t *testing.T) {
	for _, tc := range []struct{ name, endpoint string }{
		{"missing URL", ""},
		{"wrong scheme", "file:///secret"},
		{"bad URL", "https://user:secret@%zz"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Verify(context.Background(), "any-key", 8453, tc.endpoint)
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsafe error: %v", err)
			}
		})
	}
}

func TestWrongChainAndProviderErrorsAreSafe(t *testing.T) {
	for _, result := range []string{`"0x1"`, `"0x14a34"`, `"0x10000000000002105"`, `null`} {
		t.Run(result, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req map[string]json.RawMessage
				json.NewDecoder(r.Body).Decode(&req)
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req["id"]) + `,"result":` + result + `}`))
			}))
			defer server.Close()
			_, err := Verify(context.Background(), "base", 8453, server.URL+"/secret")
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("wrong-chain check: %v", err)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "provider echoed secret", http.StatusUnauthorized)
	}))
	_, err := Verify(context.Background(), "base", 8453, server.URL+"/secret")
	server.Close()
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("provider error leaked: %v", err)
	}
	_, err = Verify(context.Background(), "base", 8453, server.URL+"/secret")
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("connection error leaked: %v", err)
	}
}

func TestRPCCancellationAndDeadline(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancellation", true: "deadline"}[deadline], func(t *testing.T) {
			entered := make(chan struct{})
			stopped := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body any
				json.NewDecoder(r.Body).Decode(&body)
				close(entered)
				<-r.Context().Done()
				close(stopped)
			}))
			defer server.Close()
			var ctx context.Context
			var cancel context.CancelFunc
			if deadline {
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
			} else {
				ctx, cancel = context.WithCancel(context.Background())
			}
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := Verify(ctx, "base", 8453, server.URL); done <- err }()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("RPC never started")
			}
			if !deadline {
				cancel()
			}
			expected := context.Canceled
			if deadline {
				expected = context.DeadlineExceeded
			}
			select {
			case err := <-done:
				if !errors.Is(err, expected) {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("RPC did not stop")
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("HTTP work did not stop")
			}
		})
	}
}
