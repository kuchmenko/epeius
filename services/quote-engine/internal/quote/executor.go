package quote

import (
	"context"
	"errors"
	"math/big"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"google.golang.org/protobuf/proto"
)

var executorABI = contractabi.Executor

type fixedExecutorPreparation struct{ chain Chain }

func (s fixedExecutorPreparation) Select(ctx context.Context, saved storedQuote, r *quotev1.PrepareExecutionRequest, _ *quotev1.RouteQuote) (executionSelection, string) {
	allocations, err := quoteAllocations(ctx, s.chain, saved, r.Allocations)
	if err != nil {
		if errors.Is(err, errExecutorRoute) {
			return executionSelection{}, "Selected route is not supported by the configured executor."
		}
		if errors.Is(err, errAllocationTotal) {
			return executionSelection{}, "Allocation inputs must sum to the quoted input amount."
		}
		return executionSelection{}, "executor allocations could not be quoted"
	}
	output := new(big.Int)
	for _, allocation := range allocations {
		amount, _ := new(big.Int).SetString(allocation.Route.AmountOutAtomic, 10)
		output.Add(output, amount)
	}
	if output.BitLen() > 256 {
		return executionSelection{}, "invalid aggregate output"
	}
	return executionSelection{allocations: allocations, output: output}, ""
}

func (s fixedExecutorPreparation) Build(p *quotev1.PrepareExecutionResponse) (executionPlan, string) {
	if p.AmountOutMinimumAtomic == "0" {
		return executionPlan{}, "invalid aggregate output"
	}
	deadline, _ := strconv.ParseUint(p.DeadlineUnix, 10, 64)
	data, err := executorData(s.chain.Config, p, deadline)
	if err != nil {
		return executionPlan{}, "executor plan could not be encoded"
	}
	e := *s.chain.Config.Executor
	// Capture only the immutable linkage values used for future verification.
	configSnapshot := config.Chain{Executor: &e, Deployments: map[string]config.Deployment{
		e.UniswapDeployment: s.chain.Config.Deployments[e.UniswapDeployment],
		e.PancakeDeployment: s.chain.Config.Deployments[e.PancakeDeployment],
	}}
	tx := &quotev1.UnsignedTransaction{ChainId: s.chain.ChainID, To: common.HexToAddress(e.Address).Hex(), From: p.Recipient, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "3000000"}
	routers := map[string]string{}
	for _, a := range p.Allocations {
		routers[a.Route.DeploymentId] = configSnapshot.Deployments[a.Route.DeploymentId].Router
	}
	checks := executorChecks(tx, p.Allocations, routers)
	return executionPlan{transaction: tx, spender: tx.To, checks: checks, verify: func(ctx context.Context, reader Reader, hash common.Hash) string {
		if verifyExecutor(ctx, reader, configSnapshot, hash) != nil {
			return "executor verification failed"
		}
		return ""
	}}, ""
}

func executorChecks(tx *quotev1.UnsignedTransaction, allocations []*quotev1.QuotedAllocation, routers map[string]string) SimulationChecks {
	first := allocations[0].Route.Legs
	checks := SimulationChecks{Input: BalanceProbe{first[0].TokenIn, tx.From}, Output: BalanceProbe{first[len(first)-1].TokenOut, tx.From}}
	probes := []BalanceProbe{checks.Input, checks.Output}
	add := func(token, owner string) {
		for _, existing := range probes {
			if strings.EqualFold(existing.Token, token) && strings.EqualFold(existing.Owner, owner) {
				return
			}
		}
		probes = append(probes, BalanceProbe{token, owner})
	}
	for _, a := range allocations {
		for _, leg := range a.Route.Legs {
			checks.ClearAllowances = append(checks.ClearAllowances, AllowanceProbe{leg.TokenIn, tx.To, routers[a.Route.DeploymentId]})
			for _, token := range []string{leg.TokenIn, leg.TokenOut} {
				for _, owner := range []string{tx.From, tx.To, routers[a.Route.DeploymentId]} {
					add(token, owner)
				}
			}
		}
	}
	checks.Preserve = probes[2:]
	return checks
}

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
		quoter := chain.Quoters[a.Route.DeploymentId]
		amount, _ := new(big.Int).SetString(a.AmountInAtomic, 10)
		a.Route, err = quoter.Requote(ctx, a.Route, amount, saved.final.Block)
		if err != nil {
			return nil, err
		}
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
		if route == nil || chain.Quoters[route.DeploymentId] == nil || chain.DeploymentErrors[route.DeploymentId] != "" || len(route.Legs) < 1 || len(route.Legs) > 2 {
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
			if !ok || fee.FeePips >= 1000000 || !validAddress(leg.TokenIn) || !validAddress(leg.TokenOut) || !strings.EqualFold(input, leg.TokenIn) {
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
	for name, id := range map[string]string{"uniswapRouter": e.UniswapDeployment, "pancakeRouter": e.PancakeDeployment} {
		method := executorABI.Methods[name]
		data, err := reader.Call(ctx, target, method.ID, hash)
		if err != nil {
			return fail
		}
		values, err := evm.Unpack(method, data)
		if err != nil || values[0].(common.Address) != common.HexToAddress(chain.Deployments[id].Router) {
			return fail
		}
	}
	return nil
}
