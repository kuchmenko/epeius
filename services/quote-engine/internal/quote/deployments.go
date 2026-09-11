package quote

import (
	"context"
	"errors"
	"sync"

	"github.com/ethereum/go-ethereum/common"
)

type codeReader interface {
	Reader
	Code(context.Context, common.Address, common.Hash) ([]byte, error)
}

// VerifyDeployments isolates failures at the startup canonical snapshot.
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
	for id := range chain.Config.Deployments {
		wait.Add(1)
		go func() {
			defer wait.Done()
			var err error
			if !ok || tokenError {
				err = errors.New("configured token code unavailable")
			} else if quoter := chain.Quoters[id]; quoter != nil {
				err = quoter.Verify(ctx, hash)
			} else {
				err = errors.New("quoting implementation unavailable")
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
