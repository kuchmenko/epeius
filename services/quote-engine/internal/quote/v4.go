package quote

import (
	"context"
	"errors"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
	"google.golang.org/protobuf/proto"
)

type v4Quoter struct {
	reader     Reader
	id         string
	deployment config.Deployment
	options    uniswapv4.Options
}

type v4Candidate struct {
	id   string
	pool uniswapv4.Pool
}

func (q v4Quoter) Candidates(r *quotev1.QuoteRequest, block *quotev1.BlockContext) func(context.Context) (QuoteCandidate, bool) {
	in, out := common.HexToAddress(r.TokenIn), common.HexToAddress(r.TokenOut)
	amount, _ := new(big.Int).SetString(r.AmountInAtomic, 10)
	var candidates []v4Candidate
	for _, pool := range q.options.Pools {
		currency0, currency1 := common.HexToAddress(pool.Currency0), common.HexToAddress(pool.Currency1)
		if in != currency0 && in != currency1 || out != currency0 && out != currency1 {
			continue
		}
		id, _ := uniswapv4.PoolID(v4PoolKey(pool))
		candidates = append(candidates, v4Candidate{q.id + ":" + id.Hex(), pool})
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].id < candidates[j].id })
	return func(ctx context.Context) (QuoteCandidate, bool) {
		if len(candidates) == 0 || ctx.Err() != nil {
			return QuoteCandidate{}, false
		}
		candidate := candidates[0]
		candidates = candidates[1:]
		return QuoteCandidate{ID: candidate.id, Quote: func(ctx context.Context) (*quotev1.RouteQuote, error) {
			return q.quote(ctx, candidate.id, candidate.pool, in, out, amount, block)
		}}, true
	}
}

func (q v4Quoter) quote(ctx context.Context, id string, pool uniswapv4.Pool, in, out common.Address, amount *big.Int, block *quotev1.BlockContext) (*quotev1.RouteQuote, error) {
	start := time.Now()
	key := v4PoolKey(pool)
	poolID, err := uniswapv4.PoolID(key)
	if err != nil {
		return nil, err
	}
	provider := uniswapv4.Provider{Client: q.reader, Quoter: common.HexToAddress(q.deployment.Quoter), StateView: common.HexToAddress(q.options.StateView)}
	initialized, err := provider.PoolInitialized(ctx, key, common.HexToHash(block.Hash))
	if err != nil || !initialized {
		return nil, err
	}
	output, err := provider.Quote(ctx, key, in == key.Currency0, amount, common.HexToHash(block.Hash))
	if err != nil {
		return nil, err
	}
	leg := &quotev1.RouteLeg{
		Pool:     poolID.Hex(),
		TokenIn:  in.Hex(),
		TokenOut: out.Hex(),
		UniswapV4PoolKey: &quotev1.UniswapV4PoolKey{
			Currency0: pool.Currency0, Currency1: pool.Currency1, FeePips: pool.FeePips,
			TickSpacing: pool.TickSpacing, Hooks: pool.Hooks,
		},
	}
	return &quotev1.RouteQuote{RouteId: id, Provider: q.deployment.Kind, DeploymentId: q.id, Legs: []*quotev1.RouteLeg{leg}, AmountOutAtomic: output.String(), Block: proto.CloneOf(block), LatencyMs: uint32(time.Since(start).Milliseconds())}, nil
}

func (q v4Quoter) Requote(ctx context.Context, route *quotev1.RouteQuote, amount *big.Int, block *quotev1.BlockContext) (*quotev1.RouteQuote, error) {
	pool, ok := q.admit(route)
	if !ok {
		return nil, errors.New("Uniswap V4 route is not configured")
	}
	result, err := q.quote(ctx, route.RouteId, pool, common.HexToAddress(route.Legs[0].TokenIn), common.HexToAddress(route.Legs[0].TokenOut), amount, block)
	if err == nil && result == nil {
		return nil, errors.New("Uniswap V4 pool is unavailable")
	}
	return result, err
}

func (q v4Quoter) admit(route *quotev1.RouteQuote) (uniswapv4.Pool, bool) {
	if route == nil || route.Provider != "uniswap-v4" || route.DeploymentId != q.id || len(route.Legs) != 1 || route.Legs[0].UniswapV4PoolKey == nil || route.Legs[0].Selector != nil {
		return uniswapv4.Pool{}, false
	}
	leg := route.Legs[0]
	for _, pool := range q.options.Pools {
		key := leg.UniswapV4PoolKey
		id, _ := uniswapv4.PoolID(v4PoolKey(pool))
		if strings.EqualFold(leg.Pool, id.Hex()) && strings.EqualFold(key.Currency0, pool.Currency0) && strings.EqualFold(key.Currency1, pool.Currency1) && key.FeePips == pool.FeePips && key.TickSpacing == pool.TickSpacing && strings.EqualFold(key.Hooks, pool.Hooks) && (strings.EqualFold(leg.TokenIn, pool.Currency0) && strings.EqualFold(leg.TokenOut, pool.Currency1) || strings.EqualFold(leg.TokenIn, pool.Currency1) && strings.EqualFold(leg.TokenOut, pool.Currency0)) {
			return pool, true
		}
	}
	return uniswapv4.Pool{}, false
}

func (q v4Quoter) Verify(ctx context.Context, hash common.Hash) error {
	reader, ok := q.reader.(codeReader)
	if !ok {
		return errors.New("deployment code unavailable")
	}
	var routerCode []byte
	for _, address := range []string{q.options.PoolManager, q.deployment.Quoter, q.options.StateView, q.options.Permit2, q.deployment.Router} {
		code, err := reader.Code(ctx, common.HexToAddress(address), hash)
		if err != nil || len(code) == 0 {
			return errors.New("Uniswap V4 deployment verification failed")
		}
		if address == q.deployment.Router {
			routerCode = code
		}
	}
	for target, contract := range map[string]struct {
		method string
	}{q.deployment.Quoter: {"poolManager"}, q.options.StateView: {"poolManager"}, q.deployment.Router: {"poolManager"}} {
		var method = contractabi.UniswapV4Quoter.Methods[contract.method]
		if target == q.options.StateView {
			method = contractabi.UniswapV4StateView.Methods[contract.method]
		} else if target == q.deployment.Router {
			method = contractabi.UniswapUniversalRouter.Methods[contract.method]
		}
		data, err := reader.Call(ctx, common.HexToAddress(target), method.ID, hash)
		if err != nil {
			return errors.New("Uniswap V4 deployment verification failed")
		}
		values, err := evm.Unpack(method, data)
		if err != nil || values[0].(common.Address) != common.HexToAddress(q.options.PoolManager) {
			return errors.New("Uniswap V4 deployment verification failed")
		}
	}
	// The Universal Router exposes PoolManager but not its internal immutable
	// Permit2 address. Pin the complete deployed runtime instead of accepting an
	// unrelated contract that happens to contain the configured address.
	// https://github.com/Uniswap/universal-router/blob/3663f6db6e2fe121753cd2d899699c2dc75dca86/contracts/modules/PaymentsImmutables.sol
	if crypto.Keccak256Hash(routerCode) != common.HexToHash(q.options.RouterCodeHash) {
		return errors.New("Uniswap V4 deployment verification failed")
	}
	return nil
}

func v4PoolKey(pool uniswapv4.Pool) uniswapv4.PoolKey {
	return uniswapv4.NewPoolKey(common.HexToAddress(pool.Currency0), common.HexToAddress(pool.Currency1), pool.FeePips, pool.TickSpacing, common.HexToAddress(pool.Hooks))
}
