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
	"google.golang.org/protobuf/proto"
)

var executorABI = mustABI(`[{"name":"execute","type":"function","inputs":[{"name":"tokenIn","type":"address"},{"name":"tokenOut","type":"address"},{"name":"amountIn","type":"uint256"},{"name":"minAmountOut","type":"uint256"},{"name":"deadline","type":"uint256"},{"name":"allocations","type":"tuple[]","components":[{"name":"venue","type":"uint8"},{"name":"amountIn","type":"uint256"},{"name":"hops","type":"tuple[]","components":[{"name":"tokenOut","type":"address"},{"name":"fee","type":"uint24"}]}]}],"outputs":[{"type":"uint256"}]}]`)

// executorVenue resolves exact deployment membership, not just protocol kind.
func executorVenue(chain config.Chain, route *quotev1.RouteQuote) (uint8, error) {
	e := chain.Executor
	d, exists := chain.Deployments[route.DeploymentId]
	if e != nil && exists && d.Kind == route.Provider {
		if route.DeploymentId == e.UniswapDeployment && d.Kind == "uniswap-v3" {
			return 0, nil
		}
		if route.DeploymentId == e.PancakeDeployment && d.Kind == "pancake-v3" {
			return 1, nil
		}
	}
	return 0, errExecutorRoute
}

var errExecutorRoute = errors.New("invalid or unavailable executor allocation")
var errAllocationTotal = errors.New("allocation inputs do not sum to quoted input")

func executorData(chain config.Chain, p *quotev1.PrepareExecutionResponse, deadline uint64) ([]byte, error) {
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
		venue, err := executorVenue(chain, a.Route)
		if err != nil {
			return nil, err
		}
		item := allocation{Venue: venue}
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
	result, err := admitAllocations(chain, saved, requested)
	if err != nil {
		return nil, err
	}
	for _, a := range result {
		started := time.Now()
		tokens := []common.Address{common.HexToAddress(a.Route.Legs[0].TokenIn)}
		var fees []uint32
		for _, leg := range a.Route.Legs {
			tokens = append(tokens, common.HexToAddress(leg.TokenOut))
			fees = append(fees, leg.GetFeePips())
		}
		amount, _ := new(big.Int).SetString(a.AmountInAtomic, 10)
		legs, output, err := quotePath(ctx, chain.Client, chain.Config.Deployments[a.Route.DeploymentId], tokens, fees, amount, common.HexToHash(saved.final.Block.Hash))
		if err != nil || output == nil || output.Sign() <= 0 || output.BitLen() > 256 {
			return nil, errors.New("executor path could not be quoted")
		}
		for i, leg := range legs {
			if common.HexToAddress(leg.Pool) != common.HexToAddress(a.Route.Legs[i].Pool) {
				return nil, errors.New("executor path pool changed")
			}
		}
		a.Route.Legs = legs
		a.Route.AmountOutAtomic = output.String()
		a.Route.LatencyMs = uint32(time.Since(started).Milliseconds())
		a.Route.Block = proto.CloneOf(saved.final.Block)
		a.Route.NetworkCostOutAtomic, a.Route.EffectiveOutAtomic = nil, nil
	}
	return result, nil
}

// admitAllocations validates the entire plan before any quote RPC, including
// later allocations and the exact total. Returned routes are detached copies.
func admitAllocations(chain Chain, saved storedQuote, requested []*quotev1.RouteAllocation) ([]*quotev1.QuotedAllocation, error) {
	if chain.Config.Executor == nil || len(requested) < 1 || len(requested) > 2 {
		return nil, errExecutorRoute
	}
	total := new(big.Int)
	seen := map[uint8]bool{}
	var result []*quotev1.QuotedAllocation
	for _, a := range requested {
		if a == nil || len(a.AmountInAtomic) > 78 || !positiveInteger.MatchString(a.AmountInAtomic) {
			return nil, errors.New("invalid executor allocation amount")
		}
		amount, ok := new(big.Int).SetString(a.AmountInAtomic, 10)
		if !ok || amount.BitLen() > 256 {
			return nil, errors.New("invalid executor allocation amount")
		}
		total.Add(total, amount)
		var route *quotev1.RouteQuote
		for _, candidate := range saved.final.Routes {
			if candidate.RouteId == a.RouteId {
				route = proto.CloneOf(candidate)
				break
			}
		}
		if route == nil || chain.DeploymentErrors[route.DeploymentId] != "" || len(route.Legs) < 1 || len(route.Legs) > 2 {
			return nil, errExecutorRoute
		}
		venue, err := executorVenue(chain.Config, route)
		if err != nil || seen[venue] {
			return nil, errExecutorRoute
		}
		input := saved.request.TokenIn
		for _, leg := range route.Legs {
			if leg == nil {
				return nil, errExecutorRoute
			}
			fee, ok := leg.Selector.(*quotev1.RouteLeg_FeePips)
			if !ok || fee.FeePips >= 1000000 || !address.MatchString(leg.TokenIn) || !address.MatchString(leg.TokenOut) || !strings.EqualFold(input, leg.TokenIn) {
				return nil, errExecutorRoute
			}
			input = leg.TokenOut
		}
		if !strings.EqualFold(input, saved.request.TokenOut) {
			return nil, errExecutorRoute
		}
		seen[venue] = true
		result = append(result, &quotev1.QuotedAllocation{AmountInAtomic: amount.String(), Route: route})
	}
	if total.String() != saved.request.AmountInAtomic {
		return nil, errAllocationTotal
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
