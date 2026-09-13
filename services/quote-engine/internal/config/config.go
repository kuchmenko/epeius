package config

import (
	"bytes"
	"errors"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/pelletier/go-toml/v2"
)

const DefaultPath = "epeius.toml"

type Config struct {
	Terminal Terminal         `toml:"terminal"`
	Engine   Engine           `toml:"engine"`
	Chains   map[string]Chain `toml:"chains"`
}

type Terminal struct {
	DefaultChain   string `toml:"default_chain"`
	EngineURL      string `toml:"engine_url"`
	SearchBudgetMS int    `toml:"search_budget_ms"`
}

type Engine struct {
	ListenAddr       string `toml:"listen_addr"`
	QuoteConcurrency int    `toml:"quote_concurrency"`
}

type Chain struct {
	ChainID          int64                 `toml:"chain_id"`
	RPCURLEnv        string                `toml:"rpc_url_env"`
	ExecutionEnabled bool                  `toml:"execution_enabled"`
	Tokens           []Token               `toml:"tokens"`
	Deployments      map[string]Deployment `toml:"deployments"`
	Executor         *Executor             `toml:"executor"`
}

type Executor struct {
	Address           string `toml:"address"`
	UniswapDeployment string `toml:"uniswap_deployment"`
	PancakeDeployment string `toml:"pancake_deployment"`
}

type Token struct {
	Address  string `toml:"address"`
	Symbol   string `toml:"symbol"`
	Decimals uint32 `toml:"decimals"`
}

type Deployment struct {
	Kind             string          `toml:"kind"`
	Factory          string          `toml:"factory"`
	Quoter           string          `toml:"quoter"`
	Router           string          `toml:"router"`
	Fees             []uint32        `toml:"fees"`
	Options          *map[string]any `toml:"options"`
	ProviderConfig   any             `toml:"-"`
	configuredFields map[string]bool
}

var chainKey = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func Load(path string, validateProtocols func(Chain) error) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, errors.New("could not read config file")
	}
	var result Config
	decoder := toml.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return Config{}, errors.New("could not parse config file")
	}
	// String zero values do not preserve whether an inapplicable field was
	// omitted or explicitly empty. Keep that distinction for provider checks.
	var presence struct {
		Chains map[string]struct {
			Deployments map[string]map[string]any `toml:"deployments"`
		} `toml:"chains"`
	}
	if err := toml.Unmarshal(data, &presence); err != nil {
		return Config{}, errors.New("could not parse config file")
	}
	for chainID, rawChain := range presence.Chains {
		chain := result.Chains[chainID]
		for id, fields := range rawChain.Deployments {
			deployment := chain.Deployments[id]
			deployment.configuredFields = make(map[string]bool, len(fields))
			for field := range fields {
				deployment.configuredFields[strings.ToLower(field)] = true
			}
			chain.Deployments[id] = deployment
		}
		result.Chains[chainID] = chain
	}
	result.normalizeAddresses()
	if err := result.validate(); err != nil {
		return Config{}, err
	}
	for _, chain := range result.Chains {
		if err := validateProtocols(chain); err != nil {
			return Config{}, err
		}
	}
	return result, nil
}

func (c Config) normalizeAddresses() {
	for key, chain := range c.Chains {
		for i := range chain.Tokens {
			if common.IsHexAddress(chain.Tokens[i].Address) {
				chain.Tokens[i].Address = common.HexToAddress(chain.Tokens[i].Address).Hex()
			}
		}
		for id, deployment := range chain.Deployments {
			for _, address := range []*string{&deployment.Factory, &deployment.Quoter, &deployment.Router} {
				if common.IsHexAddress(*address) {
					*address = common.HexToAddress(*address).Hex()
				}
			}
			chain.Deployments[id] = deployment
		}
		c.Chains[key] = chain
	}
}

func (c Config) validate() error {
	if c.Terminal.DefaultChain == "" || c.Terminal.EngineURL == "" || c.Terminal.SearchBudgetMS == 0 || c.Engine.ListenAddr == "" || len(c.Chains) == 0 {
		return errors.New("terminal, engine, and at least one chain must be fully configured")
	}
	if c.Engine.QuoteConcurrency < 1 {
		return errors.New("engine.quote_concurrency must be positive")
	}
	if c.Terminal.SearchBudgetMS < 1 || c.Terminal.SearchBudgetMS > 2147478647 {
		return errors.New("terminal.search_budget_ms must be between 1 and 2147478647")
	}
	parsed, err := url.Parse(c.Terminal.EngineURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("terminal.engine_url must be an HTTP(S) URL without credentials, query, or fragment")
	}
	host, _, err := net.SplitHostPort(c.Engine.ListenAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("engine.listen_addr must use a loopback IP and port")
	}
	for key, chain := range c.Chains {
		if !chainKey.MatchString(key) {
			return errors.New("chain keys must start with a lowercase letter and contain only lowercase letters, digits, or hyphens")
		}
		if chain.ChainID < 1 || chain.ChainID > 9007199254740991 {
			return errors.New("chains.*.chain_id must be between 1 and 9007199254740991")
		}
		if chain.ExecutionEnabled && (len(chain.Tokens) < 2 || len(chain.Deployments) == 0) {
			return errors.New("execution needs at least two tokens and a deployment")
		}
		seen := map[common.Address]bool{}
		for _, token := range chain.Tokens {
			a := common.HexToAddress(token.Address)
			if !common.IsHexAddress(token.Address) || a == (common.Address{}) || seen[a] || token.Symbol == "" || token.Decimals > 255 {
				return errors.New("invalid or duplicate configured token")
			}
			seen[a] = true
		}
		for id := range chain.Deployments {
			if !chainKey.MatchString(id) {
				return errors.New("invalid deployment kind, identifier, or fees")
			}
		}
		if !envName.MatchString(chain.RPCURLEnv) {
			return errors.New("chains.*.rpc_url_env must be a valid environment variable name")
		}
	}
	if _, ok := c.Chains[c.Terminal.DefaultChain]; !ok {
		return errors.New("terminal.default_chain must name a configured chain")
	}
	return nil
}
