package quote

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv3"
	"google.golang.org/protobuf/proto"
)

var executorABI = mustABI(`[{"name":"execute","type":"function","inputs":[{"name":"tokenIn","type":"address"},{"name":"tokenOut","type":"address"},{"name":"amountIn","type":"uint256"},{"name":"minAmountOut","type":"uint256"},{"name":"deadline","type":"uint256"},{"name":"allocations","type":"tuple[]","components":[{"name":"venue","type":"uint8"},{"name":"amountIn","type":"uint256"},{"name":"hops","type":"tuple[]","components":[{"name":"tokenOut","type":"address"},{"name":"fee","type":"uint24"}]}]}],"outputs":[{"type":"uint256"}]}]`)

func executorData(p *quotev1.PrepareExecutionResponse, deadline uint64) ([]byte, error) {
	type hop struct {
		TokenOut common.Address
		Fee      *big.Int
	}
	type allocation struct {
		Venue    uint8
		AmountIn *big.Int
		Hops     []hop
	}
	var allocations []allocation
	for _, a := range p.Allocations {
		item := allocation{}
		if a.Route.Provider == "pancake-v3" {
			item.Venue = 1
		} else if a.Route.Provider != "uniswap-v3" {
			return nil, errors.New("unsupported executor venue")
		}
		item.AmountIn, _ = new(big.Int).SetString(a.AmountInAtomic, 10)
		for _, leg := range a.Route.Legs {
			item.Hops = append(item.Hops, hop{common.HexToAddress(leg.TokenOut), new(big.Int).SetUint64(uint64(leg.GetFeePips()))})
		}
		allocations = append(allocations, item)
	}
	amount, _ := new(big.Int).SetString(p.AmountInAtomic, 10)
	minimum, _ := new(big.Int).SetString(p.AmountOutMinimumAtomic, 10)
	return executorABI.Pack("execute", common.HexToAddress(p.TokenIn), common.HexToAddress(p.TokenOut), amount, minimum, new(big.Int).SetUint64(deadline), allocations)
}

// quoteAllocations reuses selected paths, never scales their full-input outputs.
// Every hop of every allocation reads the original quote's canonical block.
func quoteAllocations(ctx context.Context, chain Chain, saved storedQuote, requested []*quotev1.RouteAllocation) ([]*quotev1.QuotedAllocation, error) {
	fail := errors.New("invalid or unavailable executor allocation")
	e := chain.Config.Executor
	if e == nil || len(requested) < 1 || len(requested) > 2 {
		return nil, fail
	}
	total := new(big.Int)
	seen := map[string]bool{}
	var result []*quotev1.QuotedAllocation
	for _, a := range requested {
		if a == nil || len(a.AmountInAtomic) > 78 || !positiveInteger.MatchString(a.AmountInAtomic) {
			return nil, fail
		}
		amount, ok := new(big.Int).SetString(a.AmountInAtomic, 10)
		if !ok || amount.BitLen() > 256 {
			return nil, fail
		}
		total.Add(total, amount)
		var route *quotev1.RouteQuote
		for _, candidate := range saved.final.Routes {
			if candidate.RouteId == a.RouteId {
				route = proto.Clone(candidate).(*quotev1.RouteQuote)
				break
			}
		}
		if route == nil || seen[route.Provider] || chain.DeploymentErrors[route.DeploymentId] != "" || len(route.Legs) < 1 || len(route.Legs) > 2 || !strings.EqualFold(route.Legs[0].TokenIn, saved.request.TokenIn) || !strings.EqualFold(route.Legs[len(route.Legs)-1].TokenOut, saved.request.TokenOut) {
			return nil, fail
		}
		if route.Provider == "uniswap-v3" && route.DeploymentId != e.UniswapDeployment || route.Provider == "pancake-v3" && route.DeploymentId != e.PancakeDeployment || route.Provider != "uniswap-v3" && route.Provider != "pancake-v3" {
			return nil, fail
		}
		seen[route.Provider] = true
		result = append(result, &quotev1.QuotedAllocation{AmountInAtomic: amount.String(), Route: route})
	}
	if total.String() != saved.request.AmountInAtomic {
		return nil, fail
	}
	for _, a := range result {
		started := time.Now()
		d := chain.Config.Deployments[a.Route.DeploymentId]
		provider := uniswapv3.Provider{Client: chain.Client, FactoryAddress: common.HexToAddress(d.Factory), QuoterAddress: common.HexToAddress(d.Quoter)}
		output, _ := new(big.Int).SetString(a.AmountInAtomic, 10)
		for _, leg := range a.Route.Legs {
			pool, next, err := provider.Quote(ctx, common.HexToAddress(leg.TokenIn), common.HexToAddress(leg.TokenOut), output, leg.GetFeePips(), common.HexToHash(saved.final.Block.Hash))
			if err != nil || next == nil || next.Sign() <= 0 || next.BitLen() > 256 || pool != common.HexToAddress(leg.Pool) {
				return nil, fail
			}
			output = next
		}
		a.Route.AmountOutAtomic = output.String()
		a.Route.LatencyMs = uint32(time.Since(started).Milliseconds())
		a.Route.Block = proto.Clone(saved.final.Block).(*quotev1.BlockContext)
		a.Route.NetworkCostOutAtomic, a.Route.EffectiveOutAtomic = nil, nil
	}
	return result, nil
}

func verifyExecutor(ctx context.Context, reader Reader, chain config.Chain, hash common.Hash) error {
	fail := errors.New("executor code or router linkage verification failed")
	e := chain.Executor
	code, ok := reader.(codeReader)
	if !ok || e == nil {
		return fail
	}
	target := common.HexToAddress(e.Address)
	bytecode, err := code.Code(ctx, target, hash)
	if err != nil || len(bytecode) == 0 {
		return fail
	}
	for signature, id := range map[string]string{"uniswapRouter()": e.UniswapDeployment, "pancakeRouter()": e.PancakeDeployment} {
		data, err := reader.Call(ctx, target, crypto.Keccak256([]byte(signature))[:4], hash)
		if err != nil || len(data) != 32 || new(big.Int).SetBytes(data[:12]).Sign() != 0 || common.BytesToAddress(data) != common.HexToAddress(chain.Deployments[id].Router) {
			return fail
		}
	}
	return nil
}
