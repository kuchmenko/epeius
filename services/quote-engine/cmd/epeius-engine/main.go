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
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/quote/v1/quotev1connect"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/quote"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/encoding/protojson"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type chainJSON struct {
	*quotev1.ChainStatus
}

func (s chainJSON) MarshalJSON() ([]byte, error) {
	return protojson.MarshalOptions{EmitDefaultValues: true}.Marshal(s.ChainStatus)
}

func run(ctx context.Context, args []string, getenv func(string) string, output io.Writer) error {
	command, key, path, help, err := parseArgs(args)
	if err != nil {
		return err
	}
	if help {
		_, err := fmt.Fprintln(output, "usage: epeius-engine [--config PATH]\n       epeius-engine chains [--config PATH]\n       epeius-engine chain check KEY [--config PATH]")
		return err
	}
	settings, err := config.Load(path)
	if err != nil {
		return err
	}
	if command == "chains" {
		return printChains(output, settings, getenv)
	}
	if command == "check" {
		chain, ok := settings.Chains[key]
		if !ok {
			status := chainJSON{&quotev1.ChainStatus{Key: key, Error: "unknown chain"}}
			if err := json.NewEncoder(output).Encode(struct {
				Chain chainJSON `json:"chain"`
			}{status}); err != nil {
				return err
			}
			return errors.New(status.Error)
		}
		connected := openChains(ctx, map[string]config.Chain{key: chain}, getenv)
		status := chainJSON{quote.Status(key, connected[key])}
		if err := json.NewEncoder(output).Encode(struct {
			Chain chainJSON `json:"chain"`
		}{status}); err != nil {
			closeChains(connected)
			return err
		}
		defer closeChains(connected)
		if !status.Connected {
			return errors.New(status.Error)
		}
		return nil
	}
	return serve(ctx, settings, getenv, output)
}

func parseArgs(args []string) (command, key, path string, help bool, err error) {
	path = config.DefaultPath
	positional := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			help = true
		case "--config":
			if i+1 == len(args) {
				return "", "", "", false, errors.New("--config requires a path")
			}
			i++
			path = args[i]
		default:
			positional = append(positional, args[i])
		}
	}
	if help {
		return "", "", path, true, nil
	}
	switch {
	case len(positional) == 0:
		return "serve", "", path, false, nil
	case len(positional) == 1 && positional[0] == "chains":
		return "chains", "", path, false, nil
	case len(positional) == 3 && positional[0] == "chain" && positional[1] == "check":
		return "check", positional[2], path, false, nil
	default:
		return "", "", "", false, errors.New("invalid command; use --help")
	}
}

func printChains(output io.Writer, settings config.Config, getenv func(string) string) error {
	type item struct {
		Key           string `json:"key"`
		ChainID       string `json:"chainId"`
		RPCURLEnv     string `json:"rpcUrlEnv"`
		RPCConfigured bool   `json:"rpcConfigured"`
	}
	keys := sortedKeys(settings.Chains)
	items := make([]item, 0, len(keys))
	for _, key := range keys {
		chain := settings.Chains[key]
		items = append(items, item{key, strconv.FormatInt(chain.ChainID, 10), chain.RPCURLEnv, getenv(chain.RPCURLEnv) != ""})
	}
	return json.NewEncoder(output).Encode(struct {
		Chains []item `json:"chains"`
	}{items})
}

func serve(ctx context.Context, settings config.Config, getenv func(string) string, output io.Writer) error {
	chains := openChains(ctx, settings.Chains, getenv)
	defer closeChains(chains)
	connected := 0
	var failures []string
	for _, key := range sortedKeys(settings.Chains) {
		if chains[key].Client != nil {
			connected++
		} else {
			failures = append(failures, key+": "+chains[key].Error)
		}
	}
	if connected == 0 {
		return errors.New("all configured chains failed:\n" + strings.Join(failures, "\n"))
	}
	listener, err := net.Listen("tcp", settings.Engine.ListenAddr)
	if err != nil {
		return errors.New("could not bind engine address; check engine.listen_addr and whether the port is in use")
	}
	defer listener.Close()
	mux := http.NewServeMux()
	path, handler := quotev1connect.NewQuoteServiceHandler(quote.Handler{Chains: chains, Store: quote.NewStore(), Simulator: quote.NewTenderly(getenv), QuoteConcurrency: settings.Engine.QuoteConcurrency})
	mux.Handle(path, handler)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	defer server.Close()
	statuses := make([]chainJSON, 0, len(chains))
	for _, key := range sortedKeys(settings.Chains) {
		statuses = append(statuses, chainJSON{quote.Status(key, chains[key])})
	}
	if err := json.NewEncoder(output).Encode(struct {
		Event  string      `json:"event"`
		URL    string      `json:"url"`
		Chains []chainJSON `json:"chains"`
	}{"ready", "http://" + listener.Addr().String(), statuses}); err != nil {
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

func openChains(ctx context.Context, configured map[string]config.Chain, getenv func(string) string) map[string]quote.Chain {
	result := make(map[string]quote.Chain, len(configured))
	var mutex sync.Mutex
	var wait sync.WaitGroup
	for key, configuredChain := range configured {
		wait.Add(1)
		go func() {
			defer wait.Done()
			chain := quote.Chain{ChainID: strconv.FormatInt(configuredChain.ChainID, 10), Config: configuredChain}
			endpoint := getenv(configuredChain.RPCURLEnv)
			if endpoint == "" {
				chain.Error = "RPC URL environment variable is not set"
			} else {
				checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				client, snapshot, err := rpc.Open(checkCtx, key, configuredChain.ChainID, endpoint)
				if err != nil {
					chain.Error = err.Error()
				} else {
					chain.Client, chain.Snapshot = client, snapshot
					chain = quote.VerifyDeployments(checkCtx, chain)
				}
				cancel()
			}
			mutex.Lock()
			result[key] = chain
			mutex.Unlock()
		}()
	}
	wait.Wait()
	return result
}

func closeChains(chains map[string]quote.Chain) {
	for _, chain := range chains {
		if client, ok := chain.Client.(*rpc.Client); ok {
			client.Close()
		}
	}
}

func sortedKeys(chains map[string]config.Chain) []string {
	keys := make([]string, 0, len(chains))
	for key := range chains {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
