package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validConfig = `[terminal]
default_chain = "base"
engine_url = "http://127.0.0.1:8080"
search_budget_ms = 2500

[engine]
listen_addr = "127.0.0.1:8080"
quote_concurrency = 4

[chains.base]
chain_id = 8453
rpc_url_env = "BASE_RPC_URL"

[chains.test-net]
chain_id = 84532
rpc_url_env = "TEST_RPC_URL"
`

func loadText(t *testing.T, text string) (Config, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "epeius.toml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return Load(path)
}

func TestLoadValidConfig(t *testing.T) {
	got, err := loadText(t, validConfig)
	if err != nil {
		t.Fatal(err)
	}
	if got.Terminal.DefaultChain != "base" || got.Terminal.SearchBudgetMS != 2500 || got.Chains["test-net"].ChainID != 84532 {
		t.Fatalf("wrong config: %+v", got)
	}
}

func TestLoadRejectsInvalidConfig(t *testing.T) {
	tests := []struct{ name, old, replacement string }{
		{"unknown field", "search_budget_ms = 2500", "search_budget_ms = 2500\nunknown = true"},
		{"bad chain key", "[chains.test-net]", "[chains.Test_net]"},
		{"missing default chain", `default_chain = "base"`, `default_chain = "missing"`},
		{"zero chain ID", "chain_id = 84532", "chain_id = 0"},
		{"unsafe integer", "chain_id = 84532", "chain_id = 9007199254740992"},
		{"bad environment name", `rpc_url_env = "TEST_RPC_URL"`, `rpc_url_env = "BAD-NAME"`},
		{"bad budget", "search_budget_ms = 2500", "search_budget_ms = 2147478648"},
		{"zero quote concurrency", "quote_concurrency = 4", "quote_concurrency = 0"},
		{"public listen", `listen_addr = "127.0.0.1:8080"`, `listen_addr = "0.0.0.0:8080"`},
		{"URL credentials", `engine_url = "http://127.0.0.1:8080"`, `engine_url = "http://user:secret@127.0.0.1:8080"`},
		{"URL query", `engine_url = "http://127.0.0.1:8080"`, `engine_url = "http://127.0.0.1:8080?secret=value"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := loadText(t, strings.Replace(validConfig, test.old, test.replacement, 1))
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsafe or missing error: %v", err)
			}
		})
	}
}

func TestParseErrorDoesNotEchoSecret(t *testing.T) {
	_, err := loadText(t, validConfig+`secret = "private-value`)
	if err == nil || strings.Contains(err.Error(), "private-value") {
		t.Fatalf("unsafe error: %v", err)
	}
}

func TestExplicitExecutionConfig(t *testing.T) {
	text := validConfig + `execution_enabled = true
[[chains.test-net.tokens]]
address = "0x1111111111111111111111111111111111111111"
symbol = "A"
decimals = 18
[[chains.test-net.tokens]]
address = "0x2222222222222222222222222222222222222222"
symbol = "B"
decimals = 6
[chains.test-net.deployments.pancake]
kind = "pancake-v3"
factory = "0x3333333333333333333333333333333333333333"
quoter = "0x4444444444444444444444444444444444444444"
router = "0x5555555555555555555555555555555555555555"
fees = [500, 2500]
`
	got, err := loadText(t, text)
	if err != nil || !got.Chains["test-net"].ExecutionEnabled || len(got.Chains["test-net"].Tokens) != 2 || got.Chains["test-net"].Deployments["pancake"].Fees[1] != 2500 {
		t.Fatalf("%+v %v", got, err)
	}
	for _, test := range []struct{ old, new string }{
		{"decimals = 6", "decimals = 256"},
		{"fees = [500, 2500]", "fees = [500, 500]"},
		{"fees = [500, 2500]", "fees = [1000000]"},
		{"pancake-v3", "slipstream"},
		{"0x5555555555555555555555555555555555555555", "0x0000000000000000000000000000000000000000"},
		{"0x2222222222222222222222222222222222222222", "0x1111111111111111111111111111111111111111"},
		{"fees = [500, 2500]", "fees = [500, 2500]\nnpm = \"private-value\""},
	} {
		if _, err := loadText(t, strings.Replace(text, test.old, test.new, 1)); err == nil {
			t.Fatalf("accepted %s", test.new)
		}
	}
}

func TestLoadNormalizesPrefixlessConfiguredAddresses(t *testing.T) {
	const prefixed = "0x1111111111111111111111111111111111111111"
	text := validConfig + `[[chains.test-net.tokens]]
address = "` + prefixed + `"
symbol = "A"
decimals = 18
`
	t.Run("prefixed control", func(t *testing.T) {
		if _, err := loadText(t, text); err != nil {
			t.Fatalf("prefixed control rejected: %v", err)
		}
	})
	t.Run("prefixless token", func(t *testing.T) {
		got, err := loadText(t, strings.Replace(text, prefixed, strings.TrimPrefix(prefixed, "0x"), 1))
		if err != nil || got.Chains["test-net"].Tokens[0].Address != prefixed {
			t.Fatalf("address = %q, error = %v", got.Chains["test-net"].Tokens[0].Address, err)
		}
	})
	t.Run("prefixless deployment", func(t *testing.T) {
		deploymentText := validConfig + `[chains.test-net.deployments.dex]
kind = "uniswap-v3"
factory = "3333333333333333333333333333333333333333"
quoter = "4444444444444444444444444444444444444444"
router = "5555555555555555555555555555555555555555"
fees = [500]
`
		got, err := loadText(t, deploymentText)
		if err != nil || got.Chains["test-net"].Deployments["dex"].Factory != "0x3333333333333333333333333333333333333333" {
			t.Fatalf("deployment = %+v, error = %v", got.Chains["test-net"].Deployments["dex"], err)
		}
	})
}

func TestConfiguredNetworkTokensAndFeesHaveNoHiddenAllowlist(t *testing.T) {
	text := strings.Replace(validConfig, "chain_id = 84532", "chain_id = 11155111", 1) + "execution_enabled = true\n"
	for i := 1; i <= 7; i++ {
		text += fmt.Sprintf("[[chains.test-net.tokens]]\naddress = \"0x%040x\"\nsymbol = \"T%d\"\ndecimals = 18\n", i, i)
	}
	text += `[chains.test-net.deployments.custom]
kind = "uniswap-v3"
factory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
quoter = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
router = "0xcccccccccccccccccccccccccccccccccccccccc"
fees = [0, 1, 2, 3, 4, 5, 6, 7, 8, 999999]
`
	got, err := loadText(t, text)
	if err != nil {
		t.Fatal(err)
	}
	chain := got.Chains["test-net"]
	if chain.ChainID != 11155111 || !chain.ExecutionEnabled || len(chain.Tokens) != 7 || len(chain.Deployments["custom"].Fees) != 10 {
		t.Fatalf("configured policy changed: %+v", chain)
	}
}

func TestChainProfilesMayShareNetworkID(t *testing.T) {
	got, err := loadText(t, strings.Replace(validConfig, "chain_id = 84532", "chain_id = 8453", 1))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Chains) != 2 || got.Chains["base"].RPCURLEnv != "BASE_RPC_URL" || got.Chains["test-net"].RPCURLEnv != "TEST_RPC_URL" {
		t.Fatalf("profiles merged despite distinct keys: %+v", got.Chains)
	}
}
