package quote

import (
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
)

type providerComponents struct {
	quoter   ProtocolQuoter
	requoter allocationRequoter
	verifier deploymentVerifier
	preparer PreparationStrategy
}

type providerRegistration func(Chain, string, config.Deployment) providerComponents

func feeProvider(encode routerEncoder) providerRegistration {
	return func(chain Chain, id string, deployment config.Deployment) providerComponents {
		provider := v3Quoter{reader: chain.Client, id: id, deployment: deployment, tokens: chain.Config.Tokens}
		return providerComponents{
			quoter: provider, requoter: provider, verifier: provider,
			preparer: v3RouterPreparation{id: id, kind: deployment.Kind, target: deployment.Router, chainID: chain.ChainID, encode: encode},
		}
	}
}

var providerRegistrations = map[string]providerRegistration{
	"uniswap-v3": feeProvider(uniswapRouter02Data),
	"pancake-v3": feeProvider(pancakeV3RouterData),
	"aerodrome-slipstream": func(chain Chain, id string, deployment config.Deployment) providerComponents {
		options, ok := deployment.ProviderConfig.(slipstream.Options)
		if !ok {
			return providerComponents{}
		}
		provider := slipstreamQuoter{reader: chain.Client, id: id, deployment: deployment, tokens: chain.Config.Tokens, options: options}
		return providerComponents{
			quoter: provider, verifier: provider,
			preparer: v3RouterPreparation{id: id, kind: deployment.Kind, target: deployment.Router, chainID: chain.ChainID, encode: slipstreamRouterData, verify: verifySlipstreamSignerDiscount, verificationFactory: deployment.Factory},
		}
	},
	"balancer-v2": func(chain Chain, id string, deployment config.Deployment) providerComponents {
		options, ok := deployment.ProviderConfig.(balancer.Options)
		if !ok {
			return providerComponents{}
		}
		provider := balancerV2Quoter{reader: chain.Client, id: id, options: options, poolErrors: map[string]bool{}}
		return providerComponents{
			quoter: provider, verifier: provider,
			preparer: balancerV2Preparation{id: id, chainID: chain.ChainID, options: options},
		}
	},
}

// ConfigureChain selects each provider once from the compile-time registry.
func ConfigureChain(chain Chain) Chain {
	chain.Quoters = map[string]ProtocolQuoter{}
	chain.AllocationRequoters = map[string]allocationRequoter{}
	chain.DeploymentVerifiers = map[string]deploymentVerifier{}
	chain.Preparers = map[string]PreparationStrategy{}
	for id, deployment := range chain.Config.Deployments {
		register := providerRegistrations[deployment.Kind]
		if register == nil {
			continue
		}
		components := register(chain, id, deployment)
		if components.quoter != nil {
			chain.Quoters[id] = components.quoter
		}
		if components.requoter != nil {
			chain.AllocationRequoters[id] = components.requoter
		}
		if components.verifier != nil {
			chain.DeploymentVerifiers[id] = components.verifier
		}
		if components.preparer != nil {
			chain.Preparers[id] = components.preparer
		}
	}
	chain.AllocationPreparer = fixedExecutorPreparation{chain: chain}
	return chain
}
