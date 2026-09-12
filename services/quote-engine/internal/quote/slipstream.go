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
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
	"google.golang.org/protobuf/proto"
)

type slipstreamQuoter struct {
	reader     Reader
	id         string
	deployment config.Deployment
	tokens     []config.Token
	options    slipstream.Options
}

func (q slipstreamQuoter) Candidates(r *quotev1.QuoteRequest, block *quotev1.BlockContext) func(context.Context) (QuoteCandidate, bool) {
	// Epeius policy searches every configured spacing directly and through each
	// configured intermediate token. Sorting makes route IDs and result order
	// deterministic; arbitrary-length paths are intentionally not generated.
	tokens := []common.Address{}
	for _, token := range q.tokens {
		a := common.HexToAddress(token.Address)
		if a != common.HexToAddress(r.TokenIn) && a != common.HexToAddress(r.TokenOut) {
			tokens = append(tokens, a)
		}
	}
	sort.Slice(tokens, func(i, j int) bool { return tokens[i].Hex() < tokens[j].Hex() })
	spacings := append([]int32(nil), q.options.TickSpacings...)
	sort.Slice(spacings, func(i, j int) bool { return spacings[i] < spacings[j] })
	type path struct {
		tokens   []common.Address
		spacings []int32
		id       string
	}
	paths := []path{}
	for _, s := range spacings {
		paths = append(paths, path{[]common.Address{common.HexToAddress(r.TokenIn), common.HexToAddress(r.TokenOut)}, []int32{s}, fmt.Sprintf("%s:%d", q.id, s)})
	}
	for _, middle := range tokens {
		for _, a := range spacings {
			for _, b := range spacings {
				paths = append(paths, path{[]common.Address{common.HexToAddress(r.TokenIn), middle, common.HexToAddress(r.TokenOut)}, []int32{a, b}, fmt.Sprintf("%s:%d:%s:%d", q.id, a, middle.Hex(), b)})
			}
		}
	}
	amount, _ := new(big.Int).SetString(r.AmountInAtomic, 10)
	factory := common.HexToAddress(q.deployment.Factory)
	hash := common.HexToHash(block.Hash)
	var checkOrigin sync.Once
	var checkOriginErr error
	index := 0
	return func(ctx context.Context) (QuoteCandidate, bool) {
		if index >= len(paths) || ctx.Err() != nil {
			return QuoteCandidate{}, false
		}
		p := paths[index]
		index++
		return QuoteCandidate{ID: p.id, Quote: func(ctx context.Context) (*quotev1.RouteQuote, error) {
			start := time.Now()
			// The fee module and zero-origin discount are immutable at the pinned
			// block, so every candidate in this search shares one verification.
			checkOrigin.Do(func() {
				checkOriginErr = verifySlipstreamQuoteOrigin(ctx, q.reader, hash, factory)
			})
			if checkOriginErr != nil {
				return nil, checkOriginErr
			}
			legs, out, err := q.quote(ctx, p.tokens, p.spacings, amount, hash)
			if err != nil || out == nil {
				return nil, err
			}
			return &quotev1.RouteQuote{RouteId: p.id, Provider: q.deployment.Kind, DeploymentId: q.id, Legs: legs, AmountOutAtomic: out.String(), Block: proto.CloneOf(block), LatencyMs: uint32(time.Since(start).Milliseconds())}, nil
		}}, true
	}
}

func (q slipstreamQuoter) quote(ctx context.Context, tokens []common.Address, spacings []int32, amount *big.Int, hash common.Hash) ([]*quotev1.RouteLeg, *big.Int, error) {
	factory := common.HexToAddress(q.deployment.Factory)
	p := slipstream.Provider{Client: q.reader, FactoryAddress: factory, QuoterAddress: common.HexToAddress(q.deployment.Quoter)}
	out := new(big.Int).Set(amount)
	legs := []*quotev1.RouteLeg{}
	for i, s := range spacings {
		// Slipstream exact-input routing feeds each hop's actual quoted output into
		// the next hop, matching SwapRouter's forward path execution.
		// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/SwapRouter.sol#L124-L160
		pool, next, err := p.Quote(ctx, tokens[i], tokens[i+1], out, s, hash)
		if err != nil || next == nil {
			return nil, nil, err
		}
		out = next
		legs = append(legs, &quotev1.RouteLeg{Pool: pool.Hex(), TokenIn: tokens[i].Hex(), TokenOut: tokens[i+1].Hex(), Selector: &quotev1.RouteLeg_TickSpacing{TickSpacing: s}})
	}
	return legs, out, nil
}
func (q slipstreamQuoter) Verify(ctx context.Context, h common.Hash) error {
	r, ok := q.reader.(codeReader)
	if !ok {
		return errors.New("deployment code unavailable")
	}
	return verifySlipstreamDeployment(ctx, r, q.deployment, h)
}
