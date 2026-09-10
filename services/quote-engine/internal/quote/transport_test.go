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
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
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
	mux := http.NewServeMux()
	path, actual := quotev1connect.NewQuoteServiceHandler(quotev1connect.UnimplementedQuoteServiceHandler{})
	mux.Handle(path, actual)
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
}
