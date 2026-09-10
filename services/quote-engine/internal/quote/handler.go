package quote

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
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
	Chains    map[string]Chain
	Store     *Store
	Simulator Simulator
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
	candidates := candidates(chain.Config, in, out)
	type result struct {
		index     int
		route     *quotev1.RouteQuote
		err       *quotev1.ProviderError
		completed bool
	}
	results := make(chan result, len(candidates))
	for index, candidate := range candidates {
		go func() {
			start := time.Now()
			id := candidate.id
			deployment := chain.Config.Deployments[candidate.deployment]
			if message := chain.DeploymentErrors[candidate.deployment]; message != "" {
				results <- result{index: index, completed: true, err: &quotev1.ProviderError{Provider: deployment.Kind, RouteId: &id, Message: message}}
				return
			}
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
			item := result{index: index, completed: searchCtx.Err() == nil}
			if !item.completed {
				item.err = &quotev1.ProviderError{Provider: deployment.Kind, RouteId: &id, Message: "search budget expired"}
			} else if err != nil {
				item.err = &quotev1.ProviderError{Provider: deployment.Kind, RouteId: &id, Message: err.Error()}
			} else if output != nil {
				item.route = &quotev1.RouteQuote{RouteId: id, Provider: deployment.Kind, DeploymentId: candidate.deployment, Legs: legs, AmountOutAtomic: output.String(), Block: block, LatencyMs: uint32(time.Since(start).Milliseconds())}
			}
			results <- item
		}()
	}
	ordered := make([]result, len(candidates))
	for range candidates {
		item := <-results
		ordered[item.index] = item
	}
	if ctx.Err() != nil {
		return nil, connect.NewError(contextCode(ctx.Err()), ctx.Err())
	}
	for _, item := range ordered {
		if !item.completed {
			final.SearchComplete = false
		}
		if item.route != nil && item.completed {
			final.Routes = append(final.Routes, item.route)
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
	supported := len(chain.Config.Deployments) > len(chain.DeploymentErrors)
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

func candidates(chain config.Chain, in, out common.Address) []candidate {
	var result []candidate
	var ids []string
	for id := range chain.Deployments {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var intermediates []common.Address
	for _, token := range chain.Tokens {
		a := common.HexToAddress(token.Address)
		if a != in && a != out {
			intermediates = append(intermediates, a)
		}
	}
	sort.Slice(intermediates, func(i, j int) bool { return intermediates[i].Hex() < intermediates[j].Hex() })
	for _, id := range ids {
		fees := append([]uint32(nil), chain.Deployments[id].Fees...)
		sort.Slice(fees, func(i, j int) bool { return fees[i] < fees[j] })
		for _, fee := range fees {
			result = append(result, candidate{fmt.Sprintf("%s:%d", id, fee), id, []common.Address{in, out}, []uint32{fee}})
		}
		for _, middle := range intermediates {
			for _, first := range fees {
				for _, second := range fees {
					result = append(result, candidate{fmt.Sprintf("%s:%d:%s:%d", id, first, middle.Hex(), second), id, []common.Address{in, middle, out}, []uint32{first, second}})
				}
			}
		}
	}
	return result
}
