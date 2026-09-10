package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/quote"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, getenv func(string) string, output io.Writer) error {
	address := getenv("EPEIUS_LISTEN_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("EPEIUS_LISTEN_ADDR must use a loopback IP and port, such as 127.0.0.1:8080")
	}
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	client, snapshot, err := rpc.Open(checkCtx, getenv("EPEIUS_ENVIRONMENT"), getenv("EPEIUS_RPC_URL"))
	cancel()
	if err != nil {
		return err
	}
	defer client.Close()
	environment := quotev1.Environment_ENVIRONMENT_BASE_MAINNET
	if snapshot.Environment == "base-sepolia" {
		environment = quotev1.Environment_ENVIRONMENT_BASE_SEPOLIA
	}
	// Requests read RPC state directly; no cache, database, or index is maintained.
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return errors.New("could not bind engine address; check EPEIUS_LISTEN_ADDR and whether the port is in use")
	}
	defer listener.Close()
	mux := http.NewServeMux()
	path, handler := quotev1connect.NewQuoteServiceHandler(quote.Handler{Client: client, Environment: environment})
	mux.Handle(path, handler)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	defer server.Close()
	if err := json.NewEncoder(output).Encode(struct {
		Event string `json:"event"`
		URL   string `json:"url"`
		rpc.Snapshot
	}{"ready", "http://" + listener.Addr().String(), snapshot}); err != nil {
		return err
	}
	select {
	case err := <-served:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("engine HTTP server stopped unexpectedly")
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}
