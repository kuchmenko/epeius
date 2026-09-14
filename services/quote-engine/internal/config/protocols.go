package config

import (
	"errors"

	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
)

type deploymentValidator func(Deployment, []Token) (any, error)

var deploymentValidators = map[string]deploymentValidator{
	"uniswap-v3":           validateFeeDeployment,
	"pancake-v3":           validateFeeDeployment,
	"aerodrome-slipstream": validateSlipstreamDeployment,
	"balancer-v2":          validateBalancerDeployment,
	"uniswap-v4": func(d Deployment, tokens []Token) (any, error) {
		return validateUniswapV4(d, tokens)
	},
}

func validateFeeDeployment(d Deployment, _ []Token) (any, error) {
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

func validateSlipstreamDeployment(d Deployment, _ []Token) (any, error) {
	if !validDeploymentAddresses(d) || d.Fees != nil {
		return nil, errors.New("Slipstream deployment does not accept fees")
	}
	if d.Options == nil {
		return nil, errors.New("Slipstream options must contain only tick_spacings")
	}
	return slipstream.ParseOptions(*d.Options)
}

func validateBalancerDeployment(d Deployment, _ []Token) (any, error) {
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
	if e := chain.AtomicExecutor; e != nil {
		uniswap, uniswapOK := chain.Deployments[e.UniswapDeployment]
		pancake, pancakeOK := chain.Deployments[e.PancakeDeployment]
		slipstream, slipstreamOK := chain.Deployments[e.SlipstreamDeployment]
		balancerDeployment, balancerOK := chain.Deployments[e.BalancerDeployment]
		uniswapV4, uniswapV4OK := chain.Deployments[e.UniswapV4Deployment]
		uniswapOK = e.UniswapDeployment != "" && uniswapOK && uniswap.Kind == "uniswap-v3"
		pancakeOK = e.PancakeDeployment != "" && pancakeOK && pancake.Kind == "pancake-v3"
		slipstreamOK = e.SlipstreamDeployment != "" && slipstreamOK && slipstream.Kind == "aerodrome-slipstream"
		balancerOK = e.BalancerDeployment != "" && balancerOK && balancerDeployment.Kind == "balancer-v2"
		uniswapV4OK = e.UniswapV4Deployment != "" && uniswapV4OK && uniswapV4.Kind == "uniswap-v4"
		routers := map[common.Address]bool{}
		for _, deployment := range []struct {
			enabled bool
			value   Deployment
		}{{uniswapOK, uniswap}, {pancakeOK, pancake}, {slipstreamOK, slipstream}} {
			if deployment.enabled {
				router := common.HexToAddress(deployment.value.Router)
				if routers[router] {
					return errors.New("atomic executor provider routers must be distinct")
				}
				routers[router] = true
			}
		}
		if balancerOK && balancerDeployment.Options != nil {
			options, err := balancer.ParseOptions(*balancerDeployment.Options)
			if err != nil || len(options.Pools) == 0 {
				return errors.New("atomic executor Balancer deployment is invalid")
			}
			previous := ""
			for _, pool := range options.Pools {
				if previous != "" && pool <= previous {
					return errors.New("atomic executor Balancer pool IDs must be in strict ascending order")
				}
				previous = pool
			}
			vault := common.HexToAddress(options.Vault)
			if routers[vault] {
				return errors.New("atomic executor provider endpoints must be distinct")
			}
			routers[vault] = true
		} else if balancerOK {
			return errors.New("atomic executor Balancer deployment is invalid")
		}
		if uniswapV4OK {
			options, err := validateUniswapV4(uniswapV4, chain.Tokens)
			if err != nil {
				return errors.New("atomic executor Uniswap V4 deployment is invalid")
			}
			for _, endpoint := range []string{uniswapV4.Router, options.Permit2, options.PoolManager} {
				address := common.HexToAddress(endpoint)
				if routers[address] {
					return errors.New("atomic executor provider endpoints must be distinct")
				}
				routers[address] = true
			}
		}
		if !common.IsHexAddress(e.Address) || common.HexToAddress(e.Address) == (common.Address{}) || !common.IsHexHash(e.RuntimeCodeHash) || (!uniswapOK && !pancakeOK && !slipstreamOK && !balancerOK && !uniswapV4OK) || (e.UniswapDeployment != "" && !uniswapOK) || (e.PancakeDeployment != "" && !pancakeOK) || (e.SlipstreamDeployment != "" && !slipstreamOK) || (e.BalancerDeployment != "" && !balancerOK) || (e.UniswapV4Deployment != "" && !uniswapV4OK) {
			return errors.New("atomic executor needs a nonzero address, runtime code hash, and at least one valid provider deployment")
		}
	}
	for id, d := range chain.Deployments {
		validate, ok := deploymentValidators[d.Kind]
		if !ok {
			return errors.New("unsupported provider: " + d.Kind)
		}
		providerConfig, err := validate(d, chain.Tokens)
		if err != nil {
			return err
		}
		d.ProviderConfig = providerConfig
		chain.Deployments[id] = d
	}
	return nil
}

func validateUniswapV4(d Deployment, tokens []Token) (uniswapv4.Options, error) {
	if d.configuredFields["factory"] || d.Fees != nil || d.Options == nil {
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
