package config

import (
	"errors"
	"github.com/ethereum/go-ethereum/common"
)

// ValidateV3Chain is the shipped Uniswap/Pancake and fixed-executor config
// composition. Load owns TOML and chain validation, not protocol admission.
func ValidateV3Chain(chain Chain) error {
	if e := chain.Executor; e != nil {
		uni, uniOK := chain.Deployments[e.UniswapDeployment]
		pancake, pancakeOK := chain.Deployments[e.PancakeDeployment]
		if !common.IsHexAddress(e.Address) || common.HexToAddress(e.Address) == (common.Address{}) || !uniOK || !pancakeOK || uni.Kind != "uniswap-v3" || pancake.Kind != "pancake-v3" || common.HexToAddress(uni.Router) == common.HexToAddress(pancake.Router) {
			return errors.New("executor needs a nonzero address and distinct configured Uniswap and Pancake routers")
		}
	}
	for _, d := range chain.Deployments {
		if (d.Kind != "uniswap-v3" && d.Kind != "pancake-v3") || len(d.Fees) == 0 {
			return errors.New("invalid deployment kind, identifier, or fees")
		}
		for _, a := range []string{d.Factory, d.Quoter, d.Router} {
			if !common.IsHexAddress(a) || common.HexToAddress(a) == (common.Address{}) {
				return errors.New("deployment addresses must be nonzero EVM addresses")
			}
		}
		fees := map[uint32]bool{}
		for _, fee := range d.Fees {
			if fee >= 1000000 || fees[fee] {
				return errors.New("invalid or duplicate pool fee")
			}
			fees[fee] = true
		}
	}
	return nil
}
