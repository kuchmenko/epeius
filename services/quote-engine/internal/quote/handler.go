package quote

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv3"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

type Reader interface {
	uniswapv3.Caller
	Snapshot(context.Context) (rpc.Snapshot, error)
}

type Handler struct {
	// Business streaming and execution preparation remain unimplemented.
	// No approvals, signing, or transactions are performed by this service.
	quotev1connect.UnimplementedQuoteServiceHandler
	Client      Reader
	Environment quotev1.Environment
}

var positiveInteger = regexp.MustCompile(`^[1-9][0-9]*$`)
var address = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

func (h Handler) GetQuote(ctx context.Context, req *connect.Request[quotev1.QuoteRequest]) (*connect.Response[quotev1.QuoteFinal], error) {
	r := req.Msg
	invalid := func(message string) (*connect.Response[quotev1.QuoteFinal], error) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New(message))
	}
	if r.Environment != quotev1.Environment_ENVIRONMENT_BASE_MAINNET && r.Environment != quotev1.Environment_ENVIRONMENT_BASE_SEPOLIA {
		return invalid("unsupported environment")
	}
	if r.Environment != h.Environment {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("request environment does not match engine"))
	}
	if r.Environment != quotev1.Environment_ENVIRONMENT_BASE_MAINNET {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("quoting is supported on Base mainnet only"))
	}
	for _, value := range []string{r.Sender, r.Recipient, r.TokenIn, r.TokenOut} {
		if !address.MatchString(value) {
			return invalid("addresses must be 20-byte hex strings")
		}
	}
	in, out := common.HexToAddress(r.TokenIn), common.HexToAddress(r.TokenOut)
	if !((in == uniswapv3.WETH && out == uniswapv3.USDC) || (in == uniswapv3.USDC && out == uniswapv3.WETH)) {
		return invalid("only the WETH/USDC pair is supported")
	}
	if len(r.AmountInAtomic) > 78 || !positiveInteger.MatchString(r.AmountInAtomic) {
		return invalid("amount must be a positive uint256 decimal integer")
	}
	amount, ok := new(big.Int).SetString(r.AmountInAtomic, 10)
	if !ok || amount.BitLen() > 256 {
		return invalid("amount must be a positive uint256 decimal integer")
	}
	if r.SlippageBps > 10000 || r.SearchBudgetMs == 0 {
		return invalid("slippage must be at most 10000 bps and search budget must be positive")
	}
	// Sender, recipient, and slippage are validated contract inputs. QuoterV2
	// does not use them; this response is not an executable minimum-output promise.
	searchCtx, cancel := context.WithTimeout(ctx, time.Duration(r.SearchBudgetMs)*time.Millisecond)
	defer cancel()
	snapshot, err := h.Client.Snapshot(searchCtx)
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
	// This is a response identifier only, not a stored quote or execution promise.
	final := &quotev1.QuoteFinal{QuoteId: rand.Text(), Block: block, SearchComplete: true}
	// These four tiers define this search, not every fee tier enabled on Base.
	fees := [...]uint32{100, 500, 3000, 10000}
	type result struct {
		index     int
		route     *quotev1.RouteQuote
		err       *quotev1.ProviderError
		completed bool
	}
	results := make(chan result, len(fees))
	provider := uniswapv3.Provider{Client: h.Client}
	for index, fee := range fees {
		go func() {
			start := time.Now()
			id := fmt.Sprintf("uniswap-v3:%d", fee)
			pool, output, err := provider.Quote(searchCtx, in, out, amount, fee, common.HexToHash(snapshot.BlockHash))
			item := result{index: index, completed: searchCtx.Err() == nil}
			if !item.completed {
				item.err = &quotev1.ProviderError{Provider: "uniswap-v3", RouteId: &id, Message: "search budget expired"}
			} else if err != nil {
				item.err = &quotev1.ProviderError{Provider: "uniswap-v3", RouteId: &id, Message: err.Error()}
			} else if output != nil {
				item.route = &quotev1.RouteQuote{RouteId: id, Provider: "uniswap-v3", Legs: []*quotev1.RouteLeg{{Pool: pool.Hex(), TokenIn: in.Hex(), TokenOut: out.Hex(), FeePips: fee}}, AmountOutAtomic: output.String(), Block: block, LatencyMs: uint32(time.Since(start).Milliseconds())}
			}
			results <- item
		}()
	}
	ordered := make([]result, len(fees))
	for range fees {
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
	return connect.NewResponse(final), nil
}

func contextCode(err error) connect.Code {
	if errors.Is(err, context.DeadlineExceeded) {
		return connect.CodeDeadlineExceeded
	}
	return connect.CodeCanceled
}
