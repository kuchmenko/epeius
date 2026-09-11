package quote

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv3"
)

// quotePath quotes an admitted path sequentially at one pinned block. A nil
// output without an error means a pool is missing, not that the RPC failed.
func quotePath(ctx context.Context, caller uniswapv3.Caller, deployment config.Deployment, tokens []common.Address, fees []uint32, amount *big.Int, hash common.Hash) ([]*quotev1.RouteLeg, *big.Int, error) {
	provider := uniswapv3.Provider{Client: caller, FactoryAddress: common.HexToAddress(deployment.Factory), QuoterAddress: common.HexToAddress(deployment.Quoter)}
	output := new(big.Int).Set(amount)
	var legs []*quotev1.RouteLeg
	for i, fee := range fees {
		pool, next, err := provider.Quote(ctx, tokens[i], tokens[i+1], output, fee, hash)
		if err != nil || next == nil {
			return nil, nil, err
		}
		output = next
		legs = append(legs, &quotev1.RouteLeg{Pool: pool.Hex(), TokenIn: tokens[i].Hex(), TokenOut: tokens[i+1].Hex(), Selector: &quotev1.RouteLeg_FeePips{FeePips: fee}})
	}
	return legs, output, nil
}
