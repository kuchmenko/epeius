// Package rpc verifies the read-only EVM endpoint selected at startup.
package rpc

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	"github.com/ethereum/go-ethereum/ethclient"
)

type Snapshot struct {
	Environment string `json:"environment"`
	ChainID     string `json:"chainId"`
	BlockNumber string `json:"blockNumber"`
	BlockHash   string `json:"blockHash"`
}

func Verify(ctx context.Context, environment, endpoint string) (Snapshot, error) {
	expected := int64(0)
	switch environment {
	case "base-mainnet":
		expected = 8453
	case "base-sepolia":
		expected = 84532
	default:
		return Snapshot{}, errors.New("set EPEIUS_ENVIRONMENT to base-mainnet or base-sepolia")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return Snapshot{}, errors.New("set EPEIUS_RPC_URL to an HTTP or HTTPS RPC endpoint")
	}
	client, err := ethclient.DialContext(ctx, endpoint)
	if err != nil {
		return Snapshot{}, errors.New("could not connect to RPC; check EPEIUS_RPC_URL")
	}
	defer client.Close()
	chainID, err := client.ChainID(ctx)
	if err != nil {
		return Snapshot{}, readError(ctx, "chain ID")
	}
	if !chainID.IsInt64() || chainID.Int64() != expected {
		return Snapshot{}, fmt.Errorf("RPC chain ID does not match %s (expected %d)", environment, expected)
	}
	header, err := client.HeaderByNumber(ctx, nil)
	if err != nil || header.Number == nil {
		return Snapshot{}, readError(ctx, "latest block")
	}
	return Snapshot{environment, chainID.String(), header.Number.String(), header.Hash().Hex()}, nil
}

func readError(ctx context.Context, field string) error {
	// Provider errors may contain credentials or arbitrary response text.
	if ctx.Err() != nil {
		return fmt.Errorf("RPC check stopped: %w", ctx.Err())
	}
	return fmt.Errorf("could not read RPC %s; check the endpoint and provider availability", field)
}
