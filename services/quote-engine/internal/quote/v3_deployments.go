package quote

import (
	"context"
	"errors"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
)

func verifyDeployment(ctx context.Context, reader codeReader, d config.Deployment, hash common.Hash) error {
	fail := errors.New("deployment code or factory linkage verification failed")
	for _, value := range []string{d.Factory, d.Quoter, d.Router} {
		code, err := reader.Code(ctx, common.HexToAddress(value), hash)
		if err != nil || len(code) == 0 {
			return fail
		}
	}
	getter := func(target string, contract abi.ABI, name string) (common.Address, error) {
		method := contract.Methods[name]
		result, err := reader.Call(ctx, common.HexToAddress(target), method.ID, hash)
		if err != nil {
			return common.Address{}, fail
		}
		values, err := evm.Unpack(method, result)
		if err != nil {
			return common.Address{}, fail
		}
		value := values[0].(common.Address)
		if value == (common.Address{}) {
			return value, fail
		}
		return value, nil
	}
	factory := common.HexToAddress(d.Factory)
	quoterABI, routerABI := contractabi.UniswapPeripheryState, contractabi.UniswapRouter02
	if d.Kind == "aerodrome-slipstream" {
		quoterABI, routerABI = contractabi.AerodromeSlipstreamQuoterV2, contractabi.AerodromeSlipstreamRouter
	}
	if d.Kind == "pancake-v3" {
		quoterABI, routerABI = contractabi.PancakeQuoterV2, contractabi.PancakeV3Router
	}
	quoterFactory, err := getter(d.Quoter, quoterABI, "factory")
	if err != nil || quoterFactory != factory {
		return fail
	}
	// SwapRouter02's constructor calls this argument factoryV3, but the
	// inherited v3-periphery PeripheryImmutableState getter is factory().
	routerFactory, err := getter(d.Router, routerABI, "factory")
	if err != nil || routerFactory != factory {
		return fail
	}
	if d.Kind == "pancake-v3" {
		deployer, err := getter(d.Factory, contractabi.PancakeV3Factory, "poolDeployer")
		if err != nil {
			return fail
		}
		code, err := reader.Code(ctx, deployer, hash)
		if err != nil || len(code) == 0 {
			return fail
		}
		for target, contract := range map[string]abi.ABI{d.Quoter: quoterABI, d.Router: routerABI} {
			linked, err := getter(target, contract, "deployer")
			if err != nil || linked != deployer {
				return fail
			}
		}
	}
	if d.Kind == "aerodrome-slipstream" {
		module, err := getter(d.Factory, contractabi.AerodromeSlipstreamFactory, "swapFeeModule")
		if err != nil {
			return fail
		}
		code, err := reader.Code(ctx, module, hash)
		if err != nil || len(code) == 0 {
			return fail
		}
		linked, err := getter(module.Hex(), contractabi.AerodromeSlipstreamFeeModule, "factory")
		if err != nil || linked != factory {
			return fail
		}
	}
	return nil
}
