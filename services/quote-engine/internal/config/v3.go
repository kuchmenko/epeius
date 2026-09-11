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
		if d.Kind != "uniswap-v3" && d.Kind != "pancake-v3" && d.Kind != "aerodrome-slipstream" {
			return errors.New("invalid deployment kind, identifier, or fees")
		}
		if d.Kind == "aerodrome-slipstream" && (len(d.TickSpacings) == 0 || len(d.Fees) != 0) || d.Kind != "aerodrome-slipstream" && (len(d.Fees) == 0 || len(d.TickSpacings) != 0) {
			return errors.New("deployment must configure only its protocol pool selector")
		}
		if d.Kind == "aerodrome-slipstream" && (chain.ChainID != 8453 || common.HexToAddress(d.Factory) != common.HexToAddress("0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A") || common.HexToAddress(d.Quoter) != common.HexToAddress("0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0") || common.HexToAddress(d.Router) != common.HexToAddress("0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5")) {
			return errors.New("unsupported Slipstream generation")
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
		spacings := map[int32]bool{}
		for _, spacing := range d.TickSpacings {
			if spacing < -8388608 || spacing > 8388607 || spacings[spacing] {
				return errors.New("invalid or duplicate tick spacing")
			}
			spacings[spacing] = true
		}
	}
	return nil
}
