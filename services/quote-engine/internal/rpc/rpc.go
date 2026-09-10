// Package rpc provides verified, read-only EVM access.
package rpc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/ethclient"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

type Snapshot struct {
	Environment string `json:"environment"`
	ChainID     string `json:"chainId"`
	BlockNumber string `json:"blockNumber"`
	BlockHash   string `json:"blockHash"`
}

type Client struct {
	*ethclient.Client
	environment string
	chainID     string
}

func Open(ctx context.Context, environment, endpoint string) (*Client, Snapshot, error) {
	expected := int64(0)
	switch environment {
	case "base-mainnet":
		expected = 8453
	case "base-sepolia":
		expected = 84532
	default:
		return nil, Snapshot{}, errors.New("set EPEIUS_ENVIRONMENT to base-mainnet or base-sepolia")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, Snapshot{}, errors.New("set EPEIUS_RPC_URL to an HTTP or HTTPS RPC endpoint")
	}
	if parsed.Scheme == "http" && parsed.Hostname() != "localhost" && !net.ParseIP(parsed.Hostname()).IsLoopback() {
		return nil, Snapshot{}, errors.New("EPEIUS_RPC_URL must use HTTPS except for loopback endpoints")
	}
	client, err := ethclient.DialContext(ctx, endpoint)
	if err != nil {
		return nil, Snapshot{}, errors.New("could not connect to RPC; check EPEIUS_RPC_URL")
	}
	chainID, err := client.ChainID(ctx)
	if err != nil {
		client.Close()
		return nil, Snapshot{}, readError(ctx, "chain ID")
	}
	if !chainID.IsInt64() || chainID.Int64() != expected {
		client.Close()
		return nil, Snapshot{}, fmt.Errorf("RPC chain ID does not match %s (expected %d)", environment, expected)
	}
	verified := &Client{client, environment, chainID.String()}
	snapshot, err := verified.Snapshot(ctx)
	if err != nil {
		client.Close()
		return nil, Snapshot{}, err
	}
	return verified, snapshot, nil
}

func (c *Client) Snapshot(ctx context.Context) (Snapshot, error) {
	header, err := c.HeaderByNumber(ctx, nil)
	if err != nil || header == nil || header.Number == nil {
		return Snapshot{}, readError(ctx, "latest block")
	}
	return Snapshot{c.environment, c.chainID, header.Number.String(), header.Hash().Hex()}, nil
}

func (c *Client) Call(ctx context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
	var result hexutil.Bytes
	// EIP-1898 pins every read and rejects a block that is no longer canonical.
	err := c.Client.Client().CallContext(ctx, &result, "eth_call",
		map[string]any{"to": to, "data": hexutil.Bytes(data)}, gethrpc.BlockNumberOrHashWithHash(hash, true))
	if err != nil {
		return nil, readError(ctx, "contract call at the pinned block")
	}
	return result, nil
}

func readError(ctx context.Context, field string) error {
	// Provider errors may contain credentials or arbitrary response text.
	if ctx.Err() != nil {
		return fmt.Errorf("RPC check stopped: %w", ctx.Err())
	}
	return fmt.Errorf("could not read RPC %s; check the endpoint and provider availability", field)
}
