package quote

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv3"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

type streamFixture struct {
	quotev1connect.UnimplementedQuoteServiceHandler
	stopped chan string
}

func (f streamFixture) StreamQuote(ctx context.Context, req *connect.Request[quotev1.QuoteRequest], stream *connect.ServerStream[quotev1.QuoteEvent]) error {
	if err := stream.Send(&quotev1.QuoteEvent{Event: &quotev1.QuoteEvent_Quote{Quote: &quotev1.RouteQuote{RouteId: "route-a", AmountOutAtomic: "9007199254740993"}}}); err != nil {
		return err
	}
	if req.Msg.Sender == "cancel" || req.Msg.Sender == "deadline" {
		<-ctx.Done()
		f.stopped <- req.Msg.Sender
		return ctx.Err()
	}
	if err := stream.Send(&quotev1.QuoteEvent{Event: &quotev1.QuoteEvent_Error{Error: &quotev1.ProviderError{Provider: "second", Message: "test failure"}}}); err != nil {
		return err
	}
	return stream.Send(&quotev1.QuoteEvent{Event: &quotev1.QuoteEvent_Final{Final: &quotev1.QuoteFinal{QuoteId: "quote-final"}}})
}

func TestBunConnectTransport(t *testing.T) {
	stopped := make(chan string, 2)
	unaryStopped := make(chan struct{}, 8)
	reader := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(_ context.Context, to common.Address, _ []byte, _ common.Hash) ([]byte, error) {
			if to == uniswapv3.Factory {
				return poolResponse(common.HexToAddress("0x1234")), nil
			}
			return quoteResponse(987654321), nil
		},
	}
	mux := http.NewServeMux()
	path, actual := quotev1connect.NewQuoteServiceHandler(Handler{Client: reader, Environment: quotev1.Environment_ENVIRONMENT_BASE_MAINNET})
	mux.Handle(path, actual)
	reader.call = func(ctx context.Context, _ common.Address, _ []byte, _ common.Hash) ([]byte, error) {
		<-ctx.Done()
		unaryStopped <- struct{}{}
		return nil, ctx.Err()
	}
	_, slow := quotev1connect.NewQuoteServiceHandler(Handler{Client: reader, Environment: quotev1.Environment_ENVIRONMENT_BASE_MAINNET})
	mux.Handle("/slow/", http.StripPrefix("/slow", slow))
	_, fixture := quotev1connect.NewQuoteServiceHandler(streamFixture{stopped: stopped})
	mux.Handle("/fixture/", http.StripPrefix("/fixture", fixture))
	server := httptest.NewServer(mux)
	defer server.Close()
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "bun", "apps/terminal/src/transport.integration.ts")
	command.Dir = root
	command.Env = append(os.Environ(), "EPEIUS_TEST_URL="+server.URL)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Bun transport: %v\n%s", err, output)
	}
	seen := map[string]bool{}
	for range 2 {
		select {
		case name := <-stopped:
			seen[name] = true
		case <-time.After(time.Second):
			t.Fatal("server work survived client termination")
		}
	}
	if !seen["cancel"] || !seen["deadline"] {
		t.Fatal(seen)
	}
	for range 8 {
		select {
		case <-unaryStopped:
		case <-time.After(time.Second):
			t.Fatal("quote RPC work survived client termination")
		}
	}
}
