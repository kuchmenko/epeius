package config

import (
	"bytes"
	"errors"

	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
)

type deploymentValidator func(Deployment) (any, error)

var deploymentValidators = map[string]deploymentValidator{
	"uniswap-v3":           validateFeeDeployment,
	"pancake-v3":           validateFeeDeployment,
	"aerodrome-slipstream": validateSlipstreamDeployment,
	"balancer-v2":          validateBalancerDeployment,
}

func validateFeeDeployment(d Deployment) (any, error) {
	if !validDeploymentAddresses(d) || len(d.Fees) == 0 || d.Options != nil || hasV4Config(d) {
		return nil, errors.New("fee deployment must configure fees and no provider options")
	}
	fees := map[uint32]bool{}
	for _, fee := range d.Fees {
		if fee >= 1000000 || fees[fee] {
			return nil, errors.New("invalid or duplicate pool fee")
		}
		fees[fee] = true
	}
	return nil, nil
}

func validateSlipstreamDeployment(d Deployment) (any, error) {
	if !validDeploymentAddresses(d) || d.Fees != nil || hasV4Config(d) {
		return nil, errors.New("Slipstream deployment does not accept fees")
	}
	if d.Options == nil {
		return nil, errors.New("Slipstream options must contain only tick_spacings")
	}
	return slipstream.ParseOptions(*d.Options)
}

func validateBalancerDeployment(d Deployment) (any, error) {
	if d.configuredFields["factory"] || d.configuredFields["quoter"] || d.configuredFields["router"] || d.Fees != nil || d.Options == nil || hasV4Config(d) {
		return nil, errors.New("Balancer V2 deployment accepts only provider options")
	}
	return balancer.ParseOptions(*d.Options)
}

func validDeploymentAddresses(d Deployment) bool {
	for _, address := range []string{d.Factory, d.Quoter, d.Router} {
		if !common.IsHexAddress(address) || common.HexToAddress(address) == (common.Address{}) {
			return false
		}
	}
	return true
}

func hasV4Config(d Deployment) bool {
	return d.PoolManager != "" || d.StateView != "" || d.Permit2 != "" || d.Pools != nil
}

// ValidateChain is the shipped provider and fixed-executor config
// composition. Load owns TOML and chain validation, not protocol admission.
func ValidateChain(chain Chain) error {
	if e := chain.Executor; e != nil {
		uni, uniOK := chain.Deployments[e.UniswapDeployment]
		pancake, pancakeOK := chain.Deployments[e.PancakeDeployment]
		if !common.IsHexAddress(e.Address) || common.HexToAddress(e.Address) == (common.Address{}) || !uniOK || !pancakeOK || uni.Kind != "uniswap-v3" || pancake.Kind != "pancake-v3" || common.HexToAddress(uni.Router) == common.HexToAddress(pancake.Router) {
			return errors.New("executor needs a nonzero address and distinct configured Uniswap and Pancake routers")
		}
	}
	for id, d := range chain.Deployments {
		if d.Kind == "uniswap-v4" {
			if err := validateUniswapV4(d, chain.Tokens); err != nil {
				return err
			}
			continue
		}
		validate, ok := deploymentValidators[d.Kind]
		if !ok {
			return errors.New("unsupported provider: " + d.Kind)
		}
		providerConfig, err := validate(d)
		if err != nil {
			return err
		}
		d.ProviderConfig = providerConfig
		chain.Deployments[id] = d
	}
	return nil
}

func validateUniswapV4(d Deployment, tokens []Token) error {
	if d.Factory != "" || d.Fees != nil || d.Options != nil || len(d.Pools) == 0 {
		return errors.New("invalid Uniswap V4 deployment")
	}
	for _, address := range []string{d.Quoter, d.Router, d.PoolManager, d.StateView, d.Permit2} {
		if !common.IsHexAddress(address) || common.HexToAddress(address) == (common.Address{}) {
			return errors.New("Uniswap V4 deployment addresses must be nonzero EVM addresses")
		}
	}
	configured := map[common.Address]bool{}
	for _, token := range tokens {
		configured[common.HexToAddress(token.Address)] = true
	}
	seen := map[UniswapV4Pool]bool{}
	for _, pool := range d.Pools {
		currency0, currency1 := common.HexToAddress(pool.Currency0), common.HexToAddress(pool.Currency1)
		if !common.IsHexAddress(pool.Currency0) || !common.IsHexAddress(pool.Currency1) || !common.IsHexAddress(pool.Hooks) || currency0 == (common.Address{}) || currency1 == (common.Address{}) || !configured[currency0] || !configured[currency1] || bytes.Compare(currency0[:], currency1[:]) >= 0 || pool.FeePips > 1000000 || pool.FeePips == 0x800000 || pool.TickSpacing <= 0 || pool.TickSpacing > 32767 || common.HexToAddress(pool.Hooks) != (common.Address{}) || seen[pool] {
			return errors.New("invalid or duplicate Uniswap V4 pool")
		}
		seen[pool] = true
	}
	return nil
}
