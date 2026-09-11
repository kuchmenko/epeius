package quote

// ConfigureChain selects the supported implementations at startup. Shared flows
// never infer an implementation from protocol names or configuration fields.
func ConfigureChain(chain Chain) Chain {
	chain.Quoters = map[string]ProtocolQuoter{}
	for id, deployment := range chain.Config.Deployments {
		switch deployment.Kind {
		case "uniswap-v3", "pancake-v3":
			chain.Quoters[id] = v3Quoter{reader: chain.Client, id: id, deployment: deployment, tokens: chain.Config.Tokens}
		}
	}
	return chain
}
