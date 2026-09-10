package config

import (
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
		{"duplicate chain ID", "chain_id = 84532", "chain_id = 8453"},
		{"missing default chain", `default_chain = "base"`, `default_chain = "missing"`},
		{"zero chain ID", "chain_id = 84532", "chain_id = 0"},
		{"unsafe integer", "chain_id = 84532", "chain_id = 9007199254740992"},
		{"bad environment name", `rpc_url_env = "TEST_RPC_URL"`, `rpc_url_env = "BAD-NAME"`},
		{"bad budget", "search_budget_ms = 2500", "search_budget_ms = 2147478648"},
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
		{"chain_id = 84532", "chain_id = 1"},
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
