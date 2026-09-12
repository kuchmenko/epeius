package config

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
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
	return Load(path, ValidateChain)
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

func TestExecutorConfigNamesTwoFixedDeploymentRouters(t *testing.T) {
	text := validConfig + `
[chains.test-net.deployments.uni]
kind = "uniswap-v3"
factory = "0x1111111111111111111111111111111111111111"
quoter = "0x2222222222222222222222222222222222222222"
router = "0x3333333333333333333333333333333333333333"
fees = [0, 500]
[chains.test-net.deployments.pan]
kind = "pancake-v3"
factory = "0x4444444444444444444444444444444444444444"
quoter = "0x5555555555555555555555555555555555555555"
router = "0x6666666666666666666666666666666666666666"
fees = [0, 2500]
[chains.test-net.executor]
address = "0x7777777777777777777777777777777777777777"
uniswap_deployment = "uni"
pancake_deployment = "pan"
`
	got, err := loadText(t, text)
	if err != nil || got.Chains["test-net"].Executor.UniswapDeployment != "uni" {
		t.Fatalf("executor config rejected: %v", err)
	}
	for _, change := range [][2]string{
		{`uniswap_deployment = "uni"`, `uniswap_deployment = "pan"`},
		{`pancake_deployment = "pan"`, `pancake_deployment = "missing"`},
		{"0x7777777777777777777777777777777777777777", "0x0000000000000000000000000000000000000000"},
		{"0x6666666666666666666666666666666666666666", "0x3333333333333333333333333333333333333333"},
	} {
		if _, err := loadText(t, strings.Replace(text, change[0], change[1], 1)); err == nil {
			t.Fatalf("invalid executor accepted: %s", change[1])
		}
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
		{"0x5555555555555555555555555555555555555555", "0x0000000000000000000000000000000000000000"},
		{"0x2222222222222222222222222222222222222222", "0x1111111111111111111111111111111111111111"},
		{"fees = [500, 2500]", "fees = [500, 2500]\nnpm = \"private-value\""},
	} {
		if _, err := loadText(t, strings.Replace(text, test.old, test.new, 1)); err == nil {
			t.Fatalf("accepted %s", test.new)
		}
	}
	if _, err := loadText(t, text+"[chains.test-net.deployments.pancake.options]\n"); err == nil {
		t.Fatal("accepted explicit empty provider options for fee deployment")
	}
	if _, err := loadText(t, strings.Replace(text, "pancake-v3", "unknown", 1)); err == nil || err.Error() != "unsupported provider: unknown" {
		t.Fatalf("unknown provider error=%v", err)
	}
}

func TestSlipstreamConfigUsesOnlySignedTickSpacings(t *testing.T) {
	text := validConfig + `[chains.base.deployments.slipstream]
kind = "aerodrome-slipstream"
factory = "0x1111111111111111111111111111111111111111"
quoter = "0x2222222222222222222222222222222222222222"
router = "0x3333333333333333333333333333333333333333"
[chains.base.deployments.slipstream.options]
tick_spacings = [-8388608, -1, 1, 100, 8388607]
`
	got, err := loadText(t, text)
	options, ok := got.Chains["base"].Deployments["slipstream"].ProviderConfig.(slipstream.Options)
	if err != nil || !ok || !slices.Equal(options.TickSpacings, []int32{-8388608, -1, 1, 100, 8388607}) {
		t.Fatalf("Slipstream config rejected: %+v %v", got, err)
	}
	for _, replacement := range []string{
		"tick_spacings = []",
		"tick_spacings = [100, 100]",
		"tick_spacings = [-8388609]",
		"tick_spacings = [8388608]",
		"tick_spacings = [100]\nfees = [500]",
		"tick_spacings = [100]\nunknown = true",
	} {
		changed := strings.Replace(text, "tick_spacings = [-8388608, -1, 1, 100, 8388607]", replacement, 1)
		if _, err := loadText(t, changed); err == nil {
			t.Fatalf("accepted %s", replacement)
		}
	}
	withoutOptions := strings.Replace(text, "[chains.base.deployments.slipstream.options]\ntick_spacings = [-8388608, -1, 1, 100, 8388607]\n", "", 1)
	if _, err := loadText(t, withoutOptions); err == nil {
		t.Fatal("accepted missing Slipstream options")
	}
	withEmptyFees := strings.Replace(text, "[chains.base.deployments.slipstream.options]", "fees = []\n[chains.base.deployments.slipstream.options]", 1)
	if _, err := loadText(t, withEmptyFees); err == nil {
		t.Fatal("accepted explicit empty Slipstream fees")
	}
	if _, err := loadText(t, strings.Replace(text, "chain_id = 8453", "chain_id = 8454", 1)); err != nil {
		t.Fatal("rejected ABI-compatible Slipstream deployment outside Base")
	}
	if _, err := loadText(t, strings.Replace(text, "0x2222222222222222222222222222222222222222", "0x4444444444444444444444444444444444444444", 1)); err != nil {
		t.Fatal("rejected configured Slipstream address before runtime linkage verification")
	}
}

func TestBalancerV2RequiresEthereumVaultAndFullLowercasePoolIDs(t *testing.T) {
	const pool = "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063"
	text := validConfig + `
[chains.test-net.deployments.balancer]
kind = "balancer-v2"

[chains.test-net.deployments.balancer.options]
vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"
pools = ["` + pool + `"]
`
	got, err := loadText(t, text)
	options, ok := got.Chains["test-net"].Deployments["balancer"].ProviderConfig.(balancer.Options)
	if err != nil || !ok || options.Vault != "0xBA12222222228d8Ba445958a75a0704d566BF2C8" || !slices.Equal(options.Pools, []string{pool}) {
		t.Fatalf("Balancer config rejected: %+v %v", got, err)
	}
	for _, change := range [][2]string{
		{"0xBA12222222228d8Ba445958a75a0704d566BF2C8", "0x0000000000000000000000000000000000000000"},
		{pool, pool[:42]},
		{pool, strings.ToUpper(pool)},
		{`pools = ["` + pool + `"]`, `pools = ["` + pool + `", "` + pool + `"]`},
		{`pools = ["` + pool + `"]`, "pools = [\"" + pool + "\"]\nunknown = true"},
	} {
		if _, err := loadText(t, strings.Replace(text, change[0], change[1], 1)); err == nil {
			t.Fatalf("invalid Balancer config accepted: %s", change[1])
		}
	}
	for _, field := range []string{
		`factory = ""`,
		`quoter = ""`,
		`router = ""`,
		"fees = []",
		`Factory = "0x1111111111111111111111111111111111111111"`,
		`QuOtEr = ""`,
		`ROUTER = "0x1111111111111111111111111111111111111111"`,
	} {
		changed := strings.Replace(text, "kind = \"balancer-v2\"", "kind = \"balancer-v2\"\n"+field, 1)
		if _, err := loadText(t, changed); err == nil {
			t.Fatalf("accepted inapplicable Balancer field %s", field)
		}
	}
}

func TestUniswapV4ConfigRequiresCompleteAllowlistedNoHookPool(t *testing.T) {
	if _, registered := deploymentValidators["uniswap-v4"]; !registered {
		t.Fatal("Uniswap V4 config validator is not registered")
	}
	text := validConfig + `[[chains.test-net.tokens]]
address = "0x1111111111111111111111111111111111111111"
symbol = "A"
decimals = 18
[[chains.test-net.tokens]]
address = "0x2222222222222222222222222222222222222222"
symbol = "B"
decimals = 6
[chains.test-net.deployments.v4]
kind = "uniswap-v4"
quoter = "0x4444444444444444444444444444444444444444"
router = "0x6666666666666666666666666666666666666666"
[chains.test-net.deployments.v4.options]
pool_manager = "0x3333333333333333333333333333333333333333"
state_view = "0x5555555555555555555555555555555555555555"
permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
router_code_hash = "0x27713951fb0660a1422b710122022d90723d883dc7b72949be79cb2957d234e0"
[[chains.test-net.deployments.v4.options.pools]]
currency0 = "0x1111111111111111111111111111111111111111"
currency1 = "0x2222222222222222222222222222222222222222"
fee_pips = 500
tick_spacing = 10
hooks = "0x0000000000000000000000000000000000000000"
`
	_, err := loadText(t, text)
	if err != nil {
		t.Fatalf("valid V4 deployment rejected: %v", err)
	}
	for _, changed := range []string{
		strings.Replace(text, "[chains.test-net.deployments.v4.options]\n", "", 1),
		strings.Replace(text, "permit2 = \"0x000000000022D473030F116dDEE9F6B43aC78BA3\"", "permit2 = \"0x000000000022D473030F116dDEE9F6B43aC78BA3\"\nunknown = true", 1),
		strings.Replace(text, "permit2 = \"0x000000000022D473030F116dDEE9F6B43aC78BA3\"", "permit2 = \"0x4200000000000000000000000000000000000006\"", 1),
		strings.Replace(text, "router_code_hash = \"0x27713951fb0660a1422b710122022d90723d883dc7b72949be79cb2957d234e0\"", "router_code_hash = \"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"", 1),
		strings.Replace(text, "router_code_hash = \"0x27713951fb0660a1422b710122022d90723d883dc7b72949be79cb2957d234e0\"", "router_code_hash = \"0xaaaa\"", 1),
		strings.Replace(text, "[chains.test-net.deployments.v4.options]", "pool_manager = \"0x3333333333333333333333333333333333333333\"\n[chains.test-net.deployments.v4.options]", 1),
		strings.Replace(text, "kind = \"uniswap-v4\"", "kind = \"uniswap-v4\"\nfactory = \"\"", 1),
	} {
		if _, err := loadText(t, changed); err == nil {
			t.Fatal("accepted missing, unknown, or misplaced V4 options")
		}
	}
	for _, change := range [][2]string{
		{"fee_pips = 500", "fee_pips = 8388608"},
		{"tick_spacing = 10", "tick_spacing = 0"},
		{"0x0000000000000000000000000000000000000000", "0x8888888888888888888888888888888888888888"},
		{"currency0 = \"0x1111111111111111111111111111111111111111\"", "currency0 = \"0x2222222222222222222222222222222222222222\""},
	} {
		if _, err := loadText(t, strings.Replace(text, change[0], change[1], 1)); err == nil {
			t.Fatalf("invalid V4 pool accepted: %s", change[1])
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
