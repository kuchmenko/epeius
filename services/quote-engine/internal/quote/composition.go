package quote

// ConfigureChain selects the supported implementations at startup. Shared flows
// never infer an implementation from protocol names or configuration fields.
func ConfigureChain(chain Chain) Chain {
	chain.Quoters = map[string]ProtocolQuoter{}
	chain.Preparers = map[string]PreparationStrategy{}
	for id, deployment := range chain.Config.Deployments {
		switch deployment.Kind {
		case "uniswap-v3", "pancake-v3":
			chain.Quoters[id] = v3Quoter{reader: chain.Client, id: id, deployment: deployment, tokens: chain.Config.Tokens}
			encode := uniswapRouter02Data
			if deployment.Kind == "pancake-v3" {
				encode = pancakeV3RouterData
			}
			chain.Preparers[id] = v3RouterPreparation{id: id, kind: deployment.Kind, target: deployment.Router, chainID: chain.ChainID, encode: encode}
		case "aerodrome-slipstream":
			chain.Quoters[id] = slipstreamQuoter{reader: chain.Client, id: id, deployment: deployment, tokens: chain.Config.Tokens}
			chain.Preparers[id] = v3RouterPreparation{id: id, kind: deployment.Kind, target: deployment.Router, chainID: chain.ChainID, encode: slipstreamRouterData, verify: slipstreamDiscountCheck(deployment)}
		}
	}
	chain.AllocationPreparer = fixedExecutorPreparation{chain: chain}
	return chain
}
