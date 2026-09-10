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
	Key         string `json:"key"`
	ChainID     string `json:"chainId"`
	BlockNumber string `json:"blockNumber"`
	BlockHash   string `json:"blockHash"`
}

type Client struct {
	*ethclient.Client
	key     string
	chainID string
}

func Open(ctx context.Context, key string, expected int64, endpoint string) (*Client, Snapshot, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, Snapshot{}, errors.New("RPC endpoint must be an HTTP or HTTPS URL")
	}
	if parsed.Scheme == "http" && parsed.Hostname() != "localhost" && !net.ParseIP(parsed.Hostname()).IsLoopback() {
		return nil, Snapshot{}, errors.New("RPC endpoint must use HTTPS except for loopback endpoints")
	}
	client, err := ethclient.DialContext(ctx, endpoint)
	if err != nil {
		return nil, Snapshot{}, errors.New("could not connect to RPC; check its configured environment variable")
	}
	chainID, err := client.ChainID(ctx)
	if err != nil {
		client.Close()
		return nil, Snapshot{}, readError(ctx, "chain ID")
	}
	if !chainID.IsInt64() || chainID.Int64() != expected {
		client.Close()
		return nil, Snapshot{}, fmt.Errorf("RPC chain ID does not match %s (expected %d)", key, expected)
	}
	verified := &Client{client, key, chainID.String()}
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
	return Snapshot{c.key, c.chainID, header.Number.String(), header.Hash().Hex()}, nil
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
