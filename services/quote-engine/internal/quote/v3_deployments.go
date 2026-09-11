package quote

import (
	"context"
	"errors"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
)

func verifyDeployment(ctx context.Context, reader codeReader, d config.Deployment, hash common.Hash) error {
	fail := errors.New("deployment code or factory linkage verification failed")
	for _, value := range []string{d.Factory, d.Quoter, d.Router} {
		code, err := reader.Code(ctx, common.HexToAddress(value), hash)
		if err != nil || len(code) == 0 {
			return fail
		}
	}
	getter := func(target, signature string) (common.Address, error) {
		result, err := reader.Call(ctx, common.HexToAddress(target), crypto.Keccak256([]byte(signature))[:4], hash)
		if err != nil || len(result) != 32 {
			return common.Address{}, fail
		}
		for _, b := range result[:12] {
			if b != 0 {
				return common.Address{}, fail
			}
		}
		value := common.BytesToAddress(result)
		if value == (common.Address{}) {
			return value, fail
		}
		return value, nil
	}
	factory := common.HexToAddress(d.Factory)
	quoterFactory, err := getter(d.Quoter, "factory()")
	if err != nil || quoterFactory != factory {
		return fail
	}
	// SwapRouter02's constructor calls this argument factoryV3, but the
	// inherited v3-periphery PeripheryImmutableState getter is factory().
	routerFactory, err := getter(d.Router, "factory()")
	if err != nil || routerFactory != factory {
		return fail
	}
	if d.Kind == "pancake-v3" {
		deployer, err := getter(d.Factory, "poolDeployer()")
		if err != nil {
			return fail
		}
		code, err := reader.Code(ctx, deployer, hash)
		if err != nil || len(code) == 0 {
			return fail
		}
		for _, target := range []string{d.Quoter, d.Router} {
			linked, err := getter(target, "deployer()")
			if err != nil || linked != deployer {
				return fail
			}
		}
	}
	return nil
}
