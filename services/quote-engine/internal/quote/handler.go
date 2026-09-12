package quote

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

type Reader interface {
	Call(context.Context, common.Address, []byte, common.Hash) ([]byte, error)
	Snapshot(context.Context) (rpc.Snapshot, error)
}

// ProtocolQuoter owns protocol candidates, complete path quoting and topology.
// Candidate callbacks return nil without error for a missing route.
type ProtocolQuoter interface {
	Candidates(*quotev1.QuoteRequest, *quotev1.BlockContext) func(context.Context) (QuoteCandidate, bool)
}

type allocationRequoter interface {
	Requote(context.Context, *quotev1.RouteQuote, *big.Int, *quotev1.BlockContext) (*quotev1.RouteQuote, error)
}

type deploymentVerifier interface {
	Verify(context.Context, common.Hash) error
}

type QuoteCandidate struct {
	ID    string
	Quote func(context.Context) (*quotev1.RouteQuote, error)
}

type Handler struct {
	quotev1connect.UnimplementedQuoteServiceHandler
	Chains           map[string]Chain
	Store            *Store
	Simulator        Simulator
	QuoteConcurrency int
}

type Chain struct {
	ChainID             string
	Client              Reader
	Snapshot            rpc.Snapshot
	Error               string
	Config              config.Chain
	DeploymentErrors    map[string]string
	Quoters             map[string]ProtocolQuoter
	AllocationRequoters map[string]allocationRequoter
	DeploymentVerifiers map[string]deploymentVerifier
	Preparers           map[string]PreparationStrategy
	AllocationPreparer  PreparationStrategy
}

var positiveInteger = regexp.MustCompile(`^[1-9][0-9]*$`)

func validAddress(value string) bool {
	return strings.HasPrefix(value, "0x") && common.IsHexAddress(value)
}

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
		if !validAddress(value) {
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
	var ids []string
	for id := range chain.Config.Deployments {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var candidates searchCandidates
	for _, id := range ids {
		message := chain.DeploymentErrors[id]
		quoter := chain.Quoters[id]
		if message == "" && quoter == nil {
			message = "quoting implementation unavailable"
		}
		if message != "" {
			final.Errors = append(final.Errors, &quotev1.ProviderError{Provider: chain.Config.Deployments[id].Kind, Message: id + ": " + message})
		} else {
			candidates.sources = append(candidates.sources, candidateSource{chain.Config.Deployments[id].Kind, quoter.Candidates(r, block)})
		}
	}
	type result struct {
		index int
		route *quotev1.RouteQuote
		err   *quotev1.ProviderError
	}
	concurrency := h.QuoteConcurrency
	results := make(chan result)
	var workers sync.WaitGroup
	for range concurrency {
		index, kind, candidate, ok := candidates.next(searchCtx)
		if !ok {
			break
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				id := candidate.ID
				route, err := candidate.Quote(searchCtx)
				if searchCtx.Err() != nil {
					results <- result{index: index, err: &quotev1.ProviderError{Provider: kind, RouteId: &id, Message: "search budget expired"}}
					return
				}
				item := result{index: index}
				if err != nil {
					item.err = &quotev1.ProviderError{Provider: kind, RouteId: &id, Message: err.Error()}
				} else {
					item.route = route
				}
				results <- item
				index, kind, candidate, ok = candidates.next(searchCtx)
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

type candidateSource struct {
	kind string
	next func(context.Context) (QuoteCandidate, bool)
}

type searchCandidates struct {
	mu      sync.Mutex
	sources []candidateSource
	index   int
}

func (s *searchCandidates) next(ctx context.Context) (int, string, QuoteCandidate, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(s.sources) > 0 && ctx.Err() == nil {
		source := s.sources[0]
		candidate, ok := source.next(ctx)
		if ok {
			index := s.index
			s.index++
			return index, source.kind, candidate, true
		}
		s.sources = s.sources[1:]
	}
	return 0, "", QuoteCandidate{}, false
}
