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
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

const (
	balancerForkHolder = "0x28C6c06298d514Db089934071355E5743bf21d60"
	balancerForkSigner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	balancerForkKey    = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
)

type balancerForkSimulator struct {
	client *rpc.Client
	calls  atomic.Int32
	logf   func(string, ...any)
}

func (s *balancerForkSimulator) Simulate(ctx context.Context, tx *quotev1.UnsignedTransaction, checks SimulationChecks, snapshot rpc.Snapshot, amount, minimum *big.Int) (output string, resultErr error) {
	s.calls.Add(1)
	defer func() {
		if resultErr != nil && s.logf != nil {
			s.logf("fork simulator failed: %v", resultErr)
		}
	}()
	if tx.ChainId != "1" || tx.ValueAtomic != "0" || !validAddress(tx.From) || !validAddress(tx.To) || checks.Input.Owner != tx.From || checks.Output.Owner != tx.From {
		return "", errors.New("invalid fork simulation")
	}
	gas, err := strconv.ParseUint(tx.GasLimit, 10, 64)
	if err != nil || gas == 0 || s.client.Canonical(ctx, snapshot) != nil {
		return "", errors.New("invalid fork simulation")
	}
	probes := append([]BalanceProbe{checks.Input, checks.Output}, checks.Preserve...)
	before := make([]*big.Int, len(probes))
	for i, probe := range probes {
		before[i], err = forkTokenBalance(ctx, s.client, probe)
		if err != nil {
			return "", err
		}
	}
	var snapshotID string
	if err := s.client.Client.Client().CallContext(ctx, &snapshotID, "evm_snapshot"); err != nil || snapshotID == "" {
		return "", errors.New("fork snapshot failed")
	}
	reverted := false
	defer func() {
		if !reverted {
			var ignored bool
			_ = s.client.Client.Client().CallContext(context.Background(), &ignored, "evm_revert", snapshotID)
		}
	}()
	if err := forkSetImpersonation(ctx, s.client, tx.From, true); err != nil {
		return "", err
	}
	var transactionHash common.Hash
	err = s.client.Client.Client().CallContext(ctx, &transactionHash, "eth_sendTransaction", map[string]any{
		"from":  tx.From,
		"to":    tx.To,
		"data":  tx.Data,
		"gas":   hexutil.EncodeUint64(gas),
		"value": "0x0",
	})
	stopErr := forkSetImpersonation(ctx, s.client, tx.From, false)
	if err != nil || stopErr != nil {
		return "", errors.New("fork transaction failed")
	}
	receipt, err := forkReceipt(ctx, s.client, transactionHash)
	if err != nil || receipt.Status != types.ReceiptStatusSuccessful {
		return "", errors.New("fork transaction reverted")
	}
	after := make([]*big.Int, len(probes))
	for i, probe := range probes {
		after[i], err = forkTokenBalance(ctx, s.client, probe)
		if err != nil {
			return "", err
		}
	}
	for _, probe := range checks.ClearAllowances {
		allowance, err := forkTokenAllowance(ctx, s.client, probe)
		if err != nil || allowance.Sign() != 0 {
			return "", errSimulationAllowance
		}
	}
	var revertedOK bool
	if err := s.client.Client.Client().CallContext(ctx, &revertedOK, "evm_revert", snapshotID); err != nil || !revertedOK {
		return "", errors.New("fork revert failed")
	}
	reverted = true
	consumed := new(big.Int).Sub(before[0], after[0])
	received := new(big.Int).Sub(after[1], before[1])
	if consumed.Cmp(amount) != 0 {
		return "", errSimulationInputAmount
	}
	if received.Cmp(minimum) < 0 {
		return "", errSimulationMinimumOutput
	}
	for i := 2; i < len(probes); i++ {
		if before[i].Cmp(after[i]) != 0 {
			return "", errSimulationProtectedBalance
		}
	}
	return received.String(), nil
}

func forkTokenBalance(ctx context.Context, client *rpc.Client, probe BalanceProbe) (*big.Int, error) {
	data, _ := erc20ABI.Pack("balanceOf", common.HexToAddress(probe.Owner))
	return forkUintCall(ctx, client, probe.Token, data, "balanceOf")
}

func forkTokenAllowance(ctx context.Context, client *rpc.Client, probe AllowanceProbe) (*big.Int, error) {
	data, _ := erc20ABI.Pack("allowance", common.HexToAddress(probe.Owner), common.HexToAddress(probe.Spender))
	return forkUintCall(ctx, client, probe.Token, data, "allowance")
}

func forkUintCall(ctx context.Context, client *rpc.Client, target string, data []byte, method string) (*big.Int, error) {
	address := common.HexToAddress(target)
	raw, err := client.CallContract(ctx, ethereum.CallMsg{To: &address, Data: data}, nil)
	if err != nil {
		return nil, errors.New("fork token read failed")
	}
	values, err := evm.Unpack(erc20ABI.Methods[method], raw)
	if err != nil {
		return nil, errors.New("fork token result invalid")
	}
	return values[0].(*big.Int), nil
}

func forkSetImpersonation(ctx context.Context, client *rpc.Client, account string, enabled bool) error {
	method := "anvil_stopImpersonatingAccount"
	if enabled {
		method = "anvil_impersonateAccount"
	}
	var result any
	return client.Client.Client().CallContext(ctx, &result, method, account)
}

func forkReceipt(ctx context.Context, client *rpc.Client, hash common.Hash) (*types.Receipt, error) {
	for ctx.Err() == nil {
		receipt, err := client.TransactionReceipt(ctx, hash)
		if err == nil {
			return receipt, nil
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	return nil, ctx.Err()
}

func startBalancerFork(t *testing.T, endpoint string) (string, *rpc.Client, rpc.Snapshot) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	command := exec.Command("anvil", "--fork-url", endpoint, "--fork-block-number", "19000000", "--chain-id", "1", "--port", strconv.Itoa(port))
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Start(); err != nil {
		t.Fatal("could not start Anvil")
	}
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	})
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		client, snapshot, err := rpc.Open(ctx, "ethereum-fork", 1, url)
		cancel()
		if err == nil {
			if snapshot.BlockNumber != "19000000" || snapshot.BlockHash != expectedBalancerBlockHash {
				client.Close()
				t.Fatal("Anvil fork identity mismatch")
			}
			return url, client, snapshot
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("Anvil fork did not become ready")
	return "", nil, rpc.Snapshot{}
}

const expectedBalancerBlockHash = "0xcf384012b91b081230cdf17a3f7dd370d8e67056058af6b272b3d54aa2714fac"

func fundBalancerForkSigner(t *testing.T, client *rpc.Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var ignored any
	if err := client.Client.Client().CallContext(ctx, &ignored, "evm_setNextBlockTimestamp", time.Now().Unix()); err != nil {
		t.Fatal("could not advance fork time")
	}
	if err := forkSetImpersonation(ctx, client, balancerForkHolder, true); err != nil {
		t.Fatal("could not impersonate fork holder")
	}
	if err := client.Client.Client().CallContext(ctx, &ignored, "anvil_setBalance", balancerForkHolder, "0x56bc75e2d63100000"); err != nil {
		t.Fatal("could not fund fork holder gas")
	}
	data, _ := erc20ABI.Pack("transfer", common.HexToAddress(balancerForkSigner), big.NewInt(1_000_000_000_000_000_000))
	var hash common.Hash
	err := client.Client.Client().CallContext(ctx, &hash, "eth_sendTransaction", map[string]any{"from": balancerForkHolder, "to": dai, "data": hexutil.Encode(data)})
	stopErr := forkSetImpersonation(ctx, client, balancerForkHolder, false)
	if err != nil || stopErr != nil {
		t.Fatal("could not fund fork signer")
	}
	receipt, err := forkReceipt(ctx, client, hash)
	if err != nil || receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatal("fork funding transfer failed")
	}
}

func writeBalancerForkTerminalConfig(t *testing.T, root, engineURL string) string {
	t.Helper()
	directory := t.TempDir()
	password := filepath.Join(directory, "password")
	if err := os.WriteFile(password, []byte("fork-test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("cast", "wallet", "import", "signer", "--keystore-dir", directory, "--private-key", balancerForkKey, "--unsafe-password", "fork-test", "--quiet")
	command.Dir, command.Stdout, command.Stderr = root, io.Discard, io.Discard
	if err := command.Run(); err != nil {
		t.Fatal("could not create disposable fork keystore")
	}
	path := filepath.Join(directory, "epeius.toml")
	text := fmt.Sprintf(`[terminal]
default_chain = "ethereum-fork"
engine_url = %q
search_budget_ms = 15000

[chains.ethereum-fork]
chain_id = 1
rpc_url_env = "EPEIUS_BALANCER_FORK_RPC_URL"
execution_enabled = true

[[chains.ethereum-fork.tokens]]
address = %q
symbol = "DAI"
decimals = 18

[[chains.ethereum-fork.tokens]]
address = %q
symbol = "USDC"
decimals = 6

[chains.ethereum-fork.deployments.balancer]
kind = "balancer-v2"

[chains.ethereum-fork.deployments.balancer.options]
vault = %q
pools = [%q]
`, engineURL, dai, usdc, balancerVault, stablePool)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func runBalancerForkTerminal(t *testing.T, root, configPath, rpcURL, quoteID, routeID, confirmation string) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	args := []string{"apps/terminal/src/main.ts", "execute", "--config", configPath, "--chain", "ethereum-fork", "--quote-id", quoteID, "--route-id", routeID, "--slippage-bps", "50", "--" + confirmation, "yes"}
	directory := filepath.Dir(configPath)
	args = append(args, "--keystore", filepath.Join(directory, "signer"), "--password-file", filepath.Join(directory, "password"))
	command := exec.CommandContext(ctx, "bun", args...)
	command.Dir = root
	command.Env = append(os.Environ(), "EPEIUS_BALANCER_FORK_RPC_URL="+rpcURL)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("terminal fork execution failed: %s", strings.TrimSpace(stderr.String()))
	}
	var last map[string]any
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		if err := json.Unmarshal([]byte(line), &last); err != nil {
			t.Fatalf("invalid terminal event: %q", line)
		}
	}
	if last == nil {
		t.Fatal("terminal returned no execution event")
	}
	return last
}

func TestBalancerForkExecutionEndToEnd(t *testing.T) {
	if os.Getenv("BALANCER_FORK_E2E") != "1" {
		t.Skip("BALANCER_FORK_E2E is not enabled")
	}
	endpoint := os.Getenv("ETHEREUM_RPC_URL")
	if endpoint == "" {
		t.Fatal("ETHEREUM_RPC_URL is not set")
	}
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	rpcURL, client, _ := startBalancerFork(t, endpoint)
	defer client.Close()
	fundBalancerForkSigner(t, client)
	snapshot, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	chainConfig := config.Chain{
		ChainID:          1,
		RPCURLEnv:        "EPEIUS_BALANCER_FORK_RPC_URL",
		ExecutionEnabled: true,
		Tokens: []config.Token{
			{Address: common.HexToAddress(dai).Hex(), Symbol: "DAI", Decimals: 18},
			{Address: common.HexToAddress(usdc).Hex(), Symbol: "USDC", Decimals: 6},
		},
		Deployments: map[string]config.Deployment{"balancer": {Kind: "balancer-v2", ProviderConfig: balancer.Options{Vault: balancerVault, Pools: []string{stablePool}}}},
	}
	chain := ConfigureChain(Chain{ChainID: "1", Client: client, Snapshot: snapshot, Config: chainConfig})
	chain = VerifyDeployments(context.Background(), chain)
	if len(chain.DeploymentErrors) != 0 {
		t.Fatal("Balancer fork deployment verification failed")
	}
	simulator := &balancerForkSimulator{client: client, logf: t.Logf}
	handler := Handler{Chains: map[string]Chain{"ethereum-fork": chain}, Store: NewStore(), Simulator: simulator, QuoteConcurrency: 1}
	mux := http.NewServeMux()
	path, service := quotev1connect.NewQuoteServiceHandler(handler)
	mux.Handle(path, service)
	server := httptest.NewServer(mux)
	defer server.Close()
	configPath := writeBalancerForkTerminalConfig(t, root, server.URL)
	serviceClient := quotev1connect.NewQuoteServiceClient(http.DefaultClient, server.URL)
	quote := func() *quotev1.QuoteFinal {
		response, err := serviceClient.GetQuote(context.Background(), connect.NewRequest(&quotev1.QuoteRequest{Chain: "ethereum-fork", ChainId: "1", TokenIn: dai, TokenOut: usdc, AmountInAtomic: "1000000000000000000", SearchBudgetMs: 15000}))
		if err != nil || len(response.Msg.Routes) != 1 {
			t.Fatalf("fork quote failed: routes=%d error=%v", len(response.Msg.Routes), err)
		}
		return response.Msg
	}
	first := quote()
	approval := runBalancerForkTerminal(t, root, configPath, rpcURL, first.QuoteId, first.Routes[0].RouteId, "confirm-approval")
	approvalVerification, ok := approval["verification"].(map[string]any)
	if approval["transactionHash"] == nil || !ok || approvalVerification["outcome"] != "receipt_success" {
		t.Fatalf("approval did not pass: %+v", approval)
	}
	second := quote()
	if second.QuoteId == first.QuoteId {
		t.Fatal("approval reused the old quote")
	}
	swap := runBalancerForkTerminal(t, root, configPath, rpcURL, second.QuoteId, second.Routes[0].RouteId, "confirm-swap")
	verification, ok := swap["verification"].(map[string]any)
	if !ok || verification["outcome"] != "passed" || verification["inputSpentAtomic"] != "1000000000000000000" || verification["outputReceivedAtomic"] != "1000023" {
		t.Fatalf("swap receipt did not prove exact deltas: %+v", swap)
	}
	if simulator.calls.Load() != 2 {
		t.Fatalf("fork simulator calls = %d", simulator.calls.Load())
	}
	input, err := forkTokenBalance(context.Background(), client, BalanceProbe{Token: dai, Owner: balancerForkSigner})
	if err != nil || input.Sign() != 0 {
		t.Fatalf("unexpected final DAI balance: %v %v", input, err)
	}
	output, err := forkTokenBalance(context.Background(), client, BalanceProbe{Token: usdc, Owner: balancerForkSigner})
	if err != nil || output.Cmp(big.NewInt(1_000_023)) != 0 {
		t.Fatalf("unexpected final USDC balance: %v %v", output, err)
	}
}
