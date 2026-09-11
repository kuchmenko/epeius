package quote

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv3"
	"google.golang.org/protobuf/proto"
)

type v3Quoter struct {
	reader     Reader
	id         string
	deployment config.Deployment
	tokens     []config.Token
}

func (q v3Quoter) Candidates(r *quotev1.QuoteRequest, block *quotev1.BlockContext) func(context.Context) (QuoteCandidate, bool) {
	i := newCandidates(config.Chain{Tokens: q.tokens, Deployments: map[string]config.Deployment{q.id: q.deployment}}, common.HexToAddress(r.TokenIn), common.HexToAddress(r.TokenOut))
	amount, _ := new(big.Int).SetString(r.AmountInAtomic, 10)
	return func(ctx context.Context) (QuoteCandidate, bool) {
		_, c, ok := i.next(ctx)
		if !ok {
			return QuoteCandidate{}, false
		}
		return QuoteCandidate{ID: c.id, Quote: func(ctx context.Context) (*quotev1.RouteQuote, error) {
			start := time.Now()
			legs, output, err := quotePath(ctx, q.reader, q.deployment, c.tokens, c.fees, amount, common.HexToHash(block.Hash))
			if err != nil || output == nil {
				return nil, err
			}
			return &quotev1.RouteQuote{RouteId: c.id, Provider: q.deployment.Kind, DeploymentId: q.id, Legs: legs, AmountOutAtomic: output.String(), Block: proto.CloneOf(block), LatencyMs: uint32(time.Since(start).Milliseconds())}, nil
		}}, true
	}
}

func (q v3Quoter) Requote(ctx context.Context, route *quotev1.RouteQuote, amount *big.Int, block *quotev1.BlockContext) (*quotev1.RouteQuote, error) {
	start := time.Now()
	tokens := []common.Address{common.HexToAddress(route.Legs[0].TokenIn)}
	var fees []uint32
	for _, leg := range route.Legs {
		tokens = append(tokens, common.HexToAddress(leg.TokenOut))
		fees = append(fees, leg.GetFeePips())
	}
	legs, output, err := quotePath(ctx, q.reader, q.deployment, tokens, fees, amount, common.HexToHash(block.Hash))
	if err != nil || output == nil || output.Sign() <= 0 || output.BitLen() > 256 {
		return nil, errors.New("executor path could not be quoted")
	}
	for i, leg := range legs {
		if common.HexToAddress(leg.Pool) != common.HexToAddress(route.Legs[i].Pool) {
			return nil, errors.New("executor path pool changed")
		}
	}
	result := proto.CloneOf(route)
	result.Legs, result.AmountOutAtomic = legs, output.String()
	result.Block, result.LatencyMs = proto.CloneOf(block), uint32(time.Since(start).Milliseconds())
	result.NetworkCostOutAtomic, result.EffectiveOutAtomic = nil, nil
	return result, nil
}

func (q v3Quoter) Verify(ctx context.Context, hash common.Hash) error {
	reader, ok := q.reader.(codeReader)
	if !ok {
		return errors.New("deployment code unavailable")
	}
	return verifyDeployment(ctx, reader, q.deployment, hash)
}

// quotePath quotes an admitted path sequentially at one pinned block. A nil
// output without an error means a pool is missing, not that the RPC failed.
func quotePath(ctx context.Context, caller Reader, deployment config.Deployment, tokens []common.Address, fees []uint32, amount *big.Int, hash common.Hash) ([]*quotev1.RouteLeg, *big.Int, error) {
	provider := uniswapv3.Provider{Client: caller, FactoryAddress: common.HexToAddress(deployment.Factory), QuoterAddress: common.HexToAddress(deployment.Quoter), Pancake: deployment.Kind == "pancake-v3"}
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

type candidate struct {
	id, deployment string
	tokens         []common.Address
	fees           []uint32
}

type candidateDeployment struct {
	id   string
	fees []uint32
}

type candidateIterator struct {
	mutex                                     sync.Mutex
	deployments                               []candidateDeployment
	intermediates                             []common.Address
	in, out                                   common.Address
	deployment, direct, middle, first, second int
	index                                     int
}

func newCandidates(chain config.Chain, in, out common.Address) *candidateIterator {
	iterator := &candidateIterator{in: in, out: out}
	var ids []string
	for id := range chain.Deployments {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, token := range chain.Tokens {
		a := common.HexToAddress(token.Address)
		if a != in && a != out {
			iterator.intermediates = append(iterator.intermediates, a)
		}
	}
	sort.Slice(iterator.intermediates, func(i, j int) bool { return iterator.intermediates[i].Hex() < iterator.intermediates[j].Hex() })
	for _, id := range ids {
		fees := append([]uint32(nil), chain.Deployments[id].Fees...)
		sort.Slice(fees, func(i, j int) bool { return fees[i] < fees[j] })
		iterator.deployments = append(iterator.deployments, candidateDeployment{id: id, fees: fees})
	}
	return iterator
}

func (i *candidateIterator) next(ctx context.Context) (int, candidate, bool) {
	i.mutex.Lock()
	defer i.mutex.Unlock()
	if ctx.Err() != nil {
		return 0, candidate{}, false
	}
	for i.deployment < len(i.deployments) {
		deployment := i.deployments[i.deployment]
		if i.direct < len(deployment.fees) {
			fee := deployment.fees[i.direct]
			i.direct++
			return i.take(candidate{fmt.Sprintf("%s:%d", deployment.id, fee), deployment.id, []common.Address{i.in, i.out}, []uint32{fee}})
		}
		if i.middle < len(i.intermediates) {
			first, second := deployment.fees[i.first], deployment.fees[i.second]
			middle := i.intermediates[i.middle]
			i.second++
			if i.second == len(deployment.fees) {
				i.second = 0
				i.first++
				if i.first == len(deployment.fees) {
					i.first = 0
					i.middle++
				}
			}
			return i.take(candidate{fmt.Sprintf("%s:%d:%s:%d", deployment.id, first, middle.Hex(), second), deployment.id, []common.Address{i.in, middle, i.out}, []uint32{first, second}})
		}
		i.deployment++
		i.direct, i.middle, i.first, i.second = 0, 0, 0, 0
	}
	return 0, candidate{}, false
}

func (i *candidateIterator) take(value candidate) (int, candidate, bool) {
	index := i.index
	i.index++
	return index, value, true
}
