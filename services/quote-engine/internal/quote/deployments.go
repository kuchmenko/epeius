package quote

import (
	"context"
	"errors"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
)

type codeReader interface {
	Reader
	Code(context.Context, common.Address, common.Hash) ([]byte, error)
}

// VerifyDeployments checks explicit configuration at the startup canonical snapshot.
// Failure isolates that deployment; it must never quote against an unrelated factory.
func VerifyDeployments(ctx context.Context, chain Chain) Chain {
	chain.DeploymentErrors = map[string]string{}
	reader, ok := chain.Client.(codeReader)
	hash := common.HexToHash(chain.Snapshot.BlockHash)
	tokenError := false
	for _, token := range chain.Config.Tokens {
		if !ok {
			tokenError = true
			break
		}
		code, err := reader.Code(ctx, common.HexToAddress(token.Address), hash)
		if err != nil || len(code) == 0 {
			tokenError = true
			break
		}
	}
	var mu sync.Mutex
	var wait sync.WaitGroup
	for id, deployment := range chain.Config.Deployments {
		wait.Add(1)
		go func() {
			defer wait.Done()
			var err error
			if !ok || tokenError {
				err = errors.New("configured token code unavailable")
			} else {
				err = verifyDeployment(ctx, reader, deployment, hash)
			}
			if err != nil {
				mu.Lock()
				chain.DeploymentErrors[id] = err.Error()
				mu.Unlock()
			}
		}()
	}
	wait.Wait()
	if len(chain.DeploymentErrors) > 0 {
		chain.Error = "one or more configured deployments failed startup verification"
	}
	return chain
}

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
