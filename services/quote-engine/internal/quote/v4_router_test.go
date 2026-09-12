package quote

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

func TestUniswapV4RouterCalldataMatchesIndependentCastVector(t *testing.T) {
	pool := config.UniswapV4Pool{Currency0: "0x4200000000000000000000000000000000000006", Currency1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", FeePips: 500, TickSpacing: 10, Hooks: "0x0000000000000000000000000000000000000000"}
	data, err := uniswapV4RouterData(pool, pool.Currency0, big.NewInt(1_000_000_000_000_000_000), big.NewInt(2_000_000_000), 1777777777)
	if err != nil {
		t.Fatal(err)
	}
	want := common.FromHex("0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000069f6bc7100000000000000000000000000000000000000000000000000000000000000011000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000380000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060b0f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000077359400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000042000000000000000000000000000000000000060000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000077359400")
	if bytes.Equal(data, want) {
		t.Fatal("encoded newer periphery tuple rejected by deployed Base Universal Router")
	}
	if hash := fmt.Sprintf("%x", sha256.Sum256(data)); len(data) != 1124 || hash != "db25857dd02bc68ee7c058200a182fee1c552394b4208135792021fde1661de1" {
		t.Fatalf("router calldata differs: length=%d sha256=%s", len(data), hash)
	}
}

func TestUniswapV4PreparationReturnsExactPermit2PermissionBeforeSimulation(t *testing.T) {
	permit2 := "0x4444444444444444444444444444444444444444"
	permissionAmount := uint64(0)
	timestamp := uint64(1777777000)
	pool := config.UniswapV4Pool{Currency0: tokenA, Currency1: tokenB, FeePips: 500, TickSpacing: 10, Hooks: "0x0000000000000000000000000000000000000000"}
	poolID, _ := v4PoolID(pool)
	route := &quotev1.RouteQuote{RouteId: "v4:" + poolID.Hex(), DeploymentId: "v4", Provider: "uniswap-v4", AmountOutAtomic: "10003", Legs: []*quotev1.RouteLeg{{Pool: poolID.Hex(), TokenIn: tokenA, TokenOut: tokenB, UniswapV4PoolKey: &quotev1.UniswapV4PoolKey{Currency0: tokenA, Currency1: tokenB, FeePips: 500, TickSpacing: 10, Hooks: pool.Hooks}}}}
	reader := executionFake{readerFake: readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) {
		return rpc.Snapshot{ChainID: "8453", BlockNumber: "112233", BlockHash: blockHash, Timestamp: timestamp}, nil
	}, call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
		if hash != common.HexToHash(blockHash) {
			t.Fatal("permission read changed block")
		}
		switch to {
		case common.HexToAddress(tokenA):
			if !bytes.Equal(data[:4], crypto.Keccak256([]byte("allowance(address,address)"))[:4]) || common.BytesToAddress(data[36:68]) != common.HexToAddress(permit2) {
				t.Fatal("wrong ERC20 allowance read")
			}
			return uintWord(123456789), nil
		case common.HexToAddress(permit2):
			if !bytes.Equal(data[:4], crypto.Keccak256([]byte("allowance(address,address,address)"))[:4]) || common.BytesToAddress(data[4:36]) != common.HexToAddress(wallet) || common.BytesToAddress(data[36:68]) != common.HexToAddress(tokenA) || common.BytesToAddress(data[68:100]) != common.HexToAddress(router) {
				t.Fatal("wrong Permit2 allowance read")
			}
			return bytes.Join([][]byte{uintWord(permissionAmount), uintWord(1777779000), uintWord(7)}, nil), nil
		default:
			t.Fatalf("unexpected call to %s", to)
			return nil, nil
		}
	}}, canonical: func(context.Context, rpc.Snapshot) error { return nil }}
	simulations := 0
	deployment := config.Deployment{Kind: "uniswap-v4", Router: router, Permit2: permit2, Pools: []config.UniswapV4Pool{pool}}
	h := Handler{Store: NewStore(), Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: config.Chain{ExecutionEnabled: true, Deployments: map[string]config.Deployment{"v4": deployment}}}}, Simulator: simulationFake(func(context.Context, *quotev1.UnsignedTransaction, SimulationChecks, rpc.Snapshot, *big.Int, *big.Int) (string, error) {
		simulations++
		return "10000", nil
	})}
	h.Store.saveQuote(&quotev1.QuoteRequest{Chain: "base", ChainId: "8453", TokenIn: tokenA, TokenOut: tokenB, AmountInAtomic: "123456789"}, &quotev1.QuoteFinal{QuoteId: "v4-quote", Routes: []*quotev1.RouteQuote{route}, Block: &quotev1.BlockContext{Number: "112230", Hash: blockHash}}, time.Now())
	r := &quotev1.PrepareExecutionRequest{QuoteId: "v4-quote", RouteId: route.RouteId, Sender: wallet, SlippageBps: 75}
	first := prepare(t, configuredHandler(h), r)
	permission := first.OnChainPermission
	if first.Status != quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED || permission == nil || first.ApprovalTransaction != nil || first.Transaction != nil || permission.Target != common.HexToAddress(permit2).Hex() || permission.Token != tokenA || permission.Spender != common.HexToAddress(router).Hex() || permission.AmountAtomic != "123456789" || permission.ExpirationUnix != "1777778920" || simulations != 0 {
		t.Fatalf("wrong permission response: %+v", first)
	}
	data, _ := common.ParseHexOrString(permission.Transaction.Data)
	if !bytes.Equal(data[:4], crypto.Keccak256([]byte("approve(address,address,uint160,uint48)"))[:4]) || common.BytesToAddress(data[4:36]) != common.HexToAddress(tokenA) || common.BytesToAddress(data[36:68]) != common.HexToAddress(router) || new(big.Int).SetBytes(data[68:100]).Uint64() != 123456789 || new(big.Int).SetBytes(data[100:132]).Uint64() != 1777778920 {
		t.Fatal("Permit2 approval calldata changed")
	}
	recheck := prepare(t, configuredHandler(h), &quotev1.PrepareExecutionRequest{PreparationId: first.PreparationId})
	if !proto.Equal(first.OnChainPermission, recheck.OnChainPermission) {
		t.Fatal("permission terms changed during recheck")
	}
	permissionAmount = 123456789
	changed := prepare(t, configuredHandler(h), &quotev1.PrepareExecutionRequest{PreparationId: first.PreparationId})
	if changed.Status != quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED || simulations != 0 {
		t.Fatal("old permission preparation became executable")
	}
}

func v4PoolID(pool config.UniswapV4Pool) (common.Hash, error) {
	return uniswapv4.PoolID(v4PoolKey(pool))
}
