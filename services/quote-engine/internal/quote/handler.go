package quote

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv3"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

type Reader interface {
	uniswapv3.Caller
	Snapshot(context.Context) (rpc.Snapshot, error)
}

type Handler struct {
	quotev1connect.UnimplementedQuoteServiceHandler
	Chains           map[string]Chain
	Store            *Store
	Simulator        Simulator
	QuoteConcurrency int
}

type Chain struct {
	ChainID          string
	Client           Reader
	Snapshot         rpc.Snapshot
	Error            string
	Config           config.Chain
	DeploymentErrors map[string]string
}

var positiveInteger = regexp.MustCompile(`^[1-9][0-9]*$`)
var address = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

func (h Handler) GetQuote(ctx context.Context, req *connect.Request[quotev1.QuoteRequest]) (*connect.Response[quotev1.QuoteFinal], error) {
	if h.QuoteConcurrency < 1 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("quote concurrency is not configured"))
	}
	r := req.Msg
	invalid := func(message string) (*connect.Response[quotev1.QuoteFinal], error) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New(message))
	}
	chain, ok := h.Chains[r.Chain]
	if !ok {
		return invalid("unknown chain")
	}
	if r.ChainId != chain.ChainID {
		return invalid("chain ID does not match configured chain")
	}
	if chain.Client == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("chain is unavailable"))
	}
	if len(chain.Config.Deployments) == 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no quoting deployments configured"))
	}
	for _, value := range []string{r.TokenIn, r.TokenOut} {
		if !address.MatchString(value) {
			return invalid("addresses must be 20-byte hex strings")
		}
	}
	in, out := common.HexToAddress(r.TokenIn), common.HexToAddress(r.TokenOut)
	allowed := map[common.Address]bool{}
	for _, token := range chain.Config.Tokens {
		allowed[common.HexToAddress(token.Address)] = true
	}
	if in == out || !allowed[in] || !allowed[out] {
		return invalid("pair must contain distinct configured tokens")
	}
	if len(r.AmountInAtomic) > 78 || !positiveInteger.MatchString(r.AmountInAtomic) {
		return invalid("amount must be a positive uint256 decimal integer")
	}
	amount, ok := new(big.Int).SetString(r.AmountInAtomic, 10)
	if !ok || amount.BitLen() > 256 {
		return invalid("amount must be a positive uint256 decimal integer")
	}
	if r.SearchBudgetMs == 0 {
		return invalid("search budget must be positive")
	}
	searchCtx, cancel := context.WithTimeout(ctx, time.Duration(r.SearchBudgetMs)*time.Millisecond)
	defer cancel()
	started := time.Now()
	snapshot, err := chain.Client.Snapshot(searchCtx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, connect.NewError(contextCode(ctx.Err()), ctx.Err())
		}
		if searchCtx.Err() != nil {
			return nil, connect.NewError(connect.CodeDeadlineExceeded, errors.New("search budget expired before snapshot"))
		}
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("could not read quote block"))
	}
	block := &quotev1.BlockContext{Number: snapshot.BlockNumber, Hash: snapshot.BlockHash}
	final := &quotev1.QuoteFinal{QuoteId: rand.Text(), Block: block, SearchComplete: true}
	candidates := newCandidates(chain.Config, in, out)
	available := candidates.deployments[:0]
	for _, deployment := range candidates.deployments {
		if message := chain.DeploymentErrors[deployment.id]; message != "" {
			final.Errors = append(final.Errors, &quotev1.ProviderError{Provider: chain.Config.Deployments[deployment.id].Kind, Message: deployment.id + ": " + message})
		} else {
			available = append(available, deployment)
		}
	}
	candidates.deployments = available
	type result struct {
		index int
		route *quotev1.RouteQuote
		err   *quotev1.ProviderError
	}
	concurrency := h.QuoteConcurrency
	results := make(chan result)
	var workers sync.WaitGroup
	for range concurrency {
		index, candidate, ok := candidates.next(searchCtx)
		if !ok {
			break
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				start := time.Now()
				id := candidate.id
				deployment := chain.Config.Deployments[candidate.deployment]
				provider := uniswapv3.Provider{Client: chain.Client, FactoryAddress: common.HexToAddress(deployment.Factory), QuoterAddress: common.HexToAddress(deployment.Quoter)}
				output := new(big.Int).Set(amount)
				var legs []*quotev1.RouteLeg
				var err error
				for i, fee := range candidate.fees {
					var pool common.Address
					pool, output, err = provider.Quote(searchCtx, candidate.tokens[i], candidate.tokens[i+1], output, fee, common.HexToHash(snapshot.BlockHash))
					if err != nil || output == nil {
						break
					}
					legs = append(legs, &quotev1.RouteLeg{Pool: pool.Hex(), TokenIn: candidate.tokens[i].Hex(), TokenOut: candidate.tokens[i+1].Hex(), Selector: &quotev1.RouteLeg_FeePips{FeePips: fee}})
				}
				if searchCtx.Err() != nil {
					results <- result{index: index, err: &quotev1.ProviderError{Provider: deployment.Kind, RouteId: &id, Message: "search budget expired"}}
					return
				}
				item := result{index: index}
				if err != nil {
					item.err = &quotev1.ProviderError{Provider: deployment.Kind, RouteId: &id, Message: err.Error()}
				} else if output != nil {
					item.route = &quotev1.RouteQuote{RouteId: id, Provider: deployment.Kind, DeploymentId: candidate.deployment, Legs: legs, AmountOutAtomic: output.String(), Block: block, LatencyMs: uint32(time.Since(start).Milliseconds())}
				}
				results <- item
				index, candidate, ok = candidates.next(searchCtx)
				if !ok {
					return
				}
			}
		}()
	}
	go func() {
		workers.Wait()
		close(results)
	}()
	var ordered []result
	for item := range results {
		ordered = append(ordered, item)
	}
	if ctx.Err() != nil {
		return nil, connect.NewError(contextCode(ctx.Err()), ctx.Err())
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].index < ordered[j].index })
	final.SearchComplete = searchCtx.Err() == nil
	var bestOutput *big.Int
	for _, item := range ordered {
		if item.route != nil {
			final.Routes = append(final.Routes, item.route)
			output, _ := new(big.Int).SetString(item.route.AmountOutAtomic, 10)
			if bestOutput == nil || output.Cmp(bestOutput) > 0 {
				bestOutput = output
				final.BestRouteId = &item.route.RouteId
			}
		}
		if item.err != nil {
			final.Errors = append(final.Errors, item.err)
		}
	}
	if h.Store != nil {
		h.Store.saveQuote(r, final, started)
	}
	return connect.NewResponse(final), nil
}

func (h Handler) GetStatus(_ context.Context, _ *connect.Request[quotev1.GetStatusRequest]) (*connect.Response[quotev1.GetStatusResponse], error) {
	keys := make([]string, 0, len(h.Chains))
	for key := range h.Chains {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	response := &quotev1.GetStatusResponse{Chains: make([]*quotev1.ChainStatus, 0, len(keys))}
	for _, key := range keys {
		response.Chains = append(response.Chains, Status(key, h.Chains[key]))
	}
	return connect.NewResponse(response), nil
}

func Status(key string, chain Chain) *quotev1.ChainStatus {
	supported := len(chain.Config.Tokens) >= 2 && len(chain.Config.Deployments) > len(chain.DeploymentErrors)
	status := &quotev1.ChainStatus{Key: key, ChainId: chain.ChainID, Connected: chain.Client != nil, Error: chain.Error, QuotingSupported: supported, ExecutionEnabled: supported && chain.Config.ExecutionEnabled}
	if status.QuotingSupported {
		for _, token := range chain.Config.Tokens {
			status.Tokens = append(status.Tokens, &quotev1.Token{Address: token.Address, Symbol: token.Symbol, Decimals: token.Decimals})
		}
	}
	if status.Connected {
		status.Block = &quotev1.BlockContext{Number: chain.Snapshot.BlockNumber, Hash: chain.Snapshot.BlockHash}
	}
	return status
}

func contextCode(err error) connect.Code {
	if errors.Is(err, context.DeadlineExceeded) {
		return connect.CodeDeadlineExceeded
	}
	return connect.CodeCanceled
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
