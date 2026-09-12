package config

import (
	"errors"

	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
)

type deploymentValidator func(Deployment) (any, error)

var deploymentValidators = map[string]deploymentValidator{
	"uniswap-v3":           validateFeeDeployment,
	"pancake-v3":           validateFeeDeployment,
	"aerodrome-slipstream": validateSlipstreamDeployment,
	"balancer-v2":          validateBalancerDeployment,
}

func validateFeeDeployment(d Deployment) (any, error) {
	if !validDeploymentAddresses(d) || len(d.Fees) == 0 || d.Options != nil {
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
	if !validDeploymentAddresses(d) || d.Fees != nil {
		return nil, errors.New("Slipstream deployment does not accept fees")
	}
	if d.Options == nil {
		return nil, errors.New("Slipstream options must contain only tick_spacings")
	}
	return slipstream.ParseOptions(*d.Options)
}

func validateBalancerDeployment(d Deployment) (any, error) {
	if d.configuredFields["factory"] || d.configuredFields["quoter"] || d.configuredFields["router"] || d.Fees != nil || d.Options == nil {
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
			providerConfig, err := validateUniswapV4(d, chain.Tokens)
			if err != nil {
				return err
			}
			d.ProviderConfig = providerConfig
			chain.Deployments[id] = d
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

func validateUniswapV4(d Deployment, tokens []Token) (uniswapv4.Options, error) {
	if d.Factory != "" || d.Fees != nil || d.Options == nil {
		return uniswapv4.Options{}, errors.New("invalid Uniswap V4 deployment")
	}
	for _, address := range []string{d.Quoter, d.Router} {
		if !common.IsHexAddress(address) || common.HexToAddress(address) == (common.Address{}) {
			return uniswapv4.Options{}, errors.New("Uniswap V4 deployment addresses must be nonzero EVM addresses")
		}
	}
	options, err := uniswapv4.ParseOptions(*d.Options)
	if err != nil {
		return uniswapv4.Options{}, err
	}
	configured := map[common.Address]bool{}
	for _, token := range tokens {
		configured[common.HexToAddress(token.Address)] = true
	}
	for _, pool := range options.Pools {
		currency0, currency1 := common.HexToAddress(pool.Currency0), common.HexToAddress(pool.Currency1)
		if !configured[currency0] || !configured[currency1] {
			return uniswapv4.Options{}, errors.New("Uniswap V4 pools must use configured tokens")
		}
	}
	return options, nil
}
