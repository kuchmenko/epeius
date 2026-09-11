package quote

func configuredHandler(h Handler) Handler {
	for id, chain := range h.Chains {
		h.Chains[id] = ConfigureChain(chain)
	}
	return h
}
