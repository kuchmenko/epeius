package config

import (
	"bytes"
	"errors"
	"net"
	"net/url"
	"os"
	"regexp"

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
	ListenAddr string `toml:"listen_addr"`
}

type Chain struct {
	ChainID   int64  `toml:"chain_id"`
	RPCURLEnv string `toml:"rpc_url_env"`
}

var chainKey = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func Load(path string) (Config, error) {
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
	if err := result.validate(); err != nil {
		return Config{}, err
	}
	return result, nil
}

func (c Config) validate() error {
	if c.Terminal.DefaultChain == "" || c.Terminal.EngineURL == "" || c.Terminal.SearchBudgetMS == 0 || c.Engine.ListenAddr == "" || len(c.Chains) == 0 {
		return errors.New("terminal, engine, and at least one chain must be fully configured")
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
	ids := make(map[int64]bool, len(c.Chains))
	for key, chain := range c.Chains {
		if !chainKey.MatchString(key) {
			return errors.New("chain keys must start with a lowercase letter and contain only lowercase letters, digits, or hyphens")
		}
		if chain.ChainID < 1 || chain.ChainID > 9007199254740991 {
			return errors.New("chains.*.chain_id must be between 1 and 9007199254740991")
		}
		if ids[chain.ChainID] {
			return errors.New("chain IDs must be unique")
		}
		ids[chain.ChainID] = true
		if !envName.MatchString(chain.RPCURLEnv) {
			return errors.New("chains.*.rpc_url_env must be a valid environment variable name")
		}
	}
	if _, ok := c.Chains[c.Terminal.DefaultChain]; !ok {
		return errors.New("terminal.default_chain must name a configured chain")
	}
	return nil
}
