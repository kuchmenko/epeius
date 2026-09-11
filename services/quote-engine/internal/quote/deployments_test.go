package quote

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"testing"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

type codeFake struct {
	readerFake
	code func(context.Context, common.Address, common.Hash) ([]byte, error)
}

func (f codeFake) Code(ctx context.Context, a common.Address, h common.Hash) ([]byte, error) {
	return f.code(ctx, a, h)
}

func TestStartupDeploymentLinksAndIsolation(t *testing.T) {
	uni := config.Deployment{Kind: "uniswap-v3", Factory: tokenA, Quoter: tokenB, Router: router, Fees: []uint32{500}}
	pancake := config.Deployment{Kind: "pancake-v3", Factory: tokenC, Quoter: wallet, Router: "0x9999999999999999999999999999999999999999", Fees: []uint32{2500}}
	deployer := common.HexToAddress("0x4444444444444444444444444444444444444444")
	for _, failure := range []string{"none", "uni router factory", "pancake quoter factory", "pancake deployer", "missing token code"} {
		t.Run(failure, func(t *testing.T) {
			reader := codeFake{code: func(_ context.Context, a common.Address, h common.Hash) ([]byte, error) {
				if h != common.HexToHash(blockHash) {
					t.Error("code not pinned")
				}
				if failure == "missing token code" && a == common.HexToAddress(tokenA) {
					return nil, nil
				}
				return []byte{1}, nil
			}, readerFake: readerFake{call: func(_ context.Context, a common.Address, data []byte, h common.Hash) ([]byte, error) {
				if h != common.HexToHash(blockHash) {
					t.Error("getter not pinned")
				}
				is := func(signature string) bool { return bytes.Equal(data, crypto.Keccak256([]byte(signature))[:4]) }
				if a == common.HexToAddress(uni.Router) && is("factory()") {
					if failure == "uni router factory" {
						return poolResponse(common.HexToAddress(tokenC)), nil
					}
					return poolResponse(common.HexToAddress(tokenA)), nil
				}
				if a == common.HexToAddress(uni.Quoter) && is("factory()") {
					return poolResponse(common.HexToAddress(tokenA)), nil
				}
				if (a == common.HexToAddress(pancake.Quoter) || a == common.HexToAddress(pancake.Router)) && is("factory()") {
					if failure == "pancake quoter factory" {
						return poolResponse(common.HexToAddress(tokenA)), nil
					}
					return poolResponse(common.HexToAddress(tokenC)), nil
				}
				if a == common.HexToAddress(pancake.Factory) && is("poolDeployer()") {
					return poolResponse(deployer), nil
				}
				if (a == common.HexToAddress(pancake.Quoter) || a == common.HexToAddress(pancake.Router)) && is("deployer()") {
					if failure == "pancake deployer" && a == common.HexToAddress(pancake.Router) {
						return poolResponse(common.HexToAddress(tokenA)), nil
					}
					return poolResponse(deployer), nil
				}
				return nil, errors.New("unexpected getter")
			}}}
			chain := VerifyDeployments(context.Background(), ConfigureChain(Chain{ChainID: "84532", Client: reader, Snapshot: snapshot(), Config: config.Chain{ExecutionEnabled: true, Tokens: []config.Token{{Address: tokenA}}, Deployments: map[string]config.Deployment{"uni": uni, "pancake": pancake}}}))
			switch failure {
			case "none":
				if len(chain.DeploymentErrors) != 0 {
					t.Fatal(chain.DeploymentErrors)
				}
			case "uni router factory":
				if len(chain.DeploymentErrors) != 1 || chain.DeploymentErrors["uni"] == "" {
					t.Fatal(chain.DeploymentErrors)
				}
			case "missing token code":
				if len(chain.DeploymentErrors) != 2 || Status("test", chain).QuotingSupported {
					t.Fatal(chain.DeploymentErrors)
				}
			default:
				if len(chain.DeploymentErrors) != 1 || chain.DeploymentErrors["pancake"] == "" {
					t.Fatal(chain.DeploymentErrors)
				}
			}
		})
	}
}

func TestConfiguredMultiHopCrossProductsAndProviderIsolation(t *testing.T) {
	uni := config.Deployment{Kind: "uniswap-v3", Factory: tokenA, Quoter: tokenB, Fees: []uint32{3000, 500}}
	pancake := config.Deployment{Kind: "pancake-v3", Factory: wallet, Quoter: router, Fees: []uint32{2500, 500}}
	settings := config.Chain{Tokens: []config.Token{{Address: tokenC}, {Address: tokenA}, {Address: tokenB}}, Deployments: map[string]config.Deployment{"uni": uni, "pancake": pancake}}
	reader := readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil }, call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
		if hash != common.HexToHash(blockHash) {
			t.Error("unpinned route")
		}
		if to == common.HexToAddress(wallet) {
			return nil, errors.New("secret provider failure")
		}
		if to == common.HexToAddress(tokenA) {
			return poolResponse(common.HexToAddress(router)), nil
		}
		if to != common.HexToAddress(tokenB) {
			t.Errorf("wrong provider target %s", to)
		}
		input := new(big.Int).SetBytes(data[68:100]).Uint64()
		fee := new(big.Int).SetBytes(data[100:132]).Uint64()
		return quoteResponse(input*2 + fee), nil
	}}
	handler := configuredHandler(Handler{Store: NewStore(), Chains: map[string]Chain{"test": {ChainID: "84532", Client: reader, Config: settings}}, QuoteConcurrency: 4})
	request := &quotev1.QuoteRequest{Chain: "test", ChainId: "84532", TokenIn: tokenA, TokenOut: tokenC, AmountInAtomic: "17", SearchBudgetMs: 1000}
	response, err := handler.GetQuote(context.Background(), connect.NewRequest(request))
	if err != nil {
		t.Fatal(err)
	}
	routes := response.Msg.Routes
	if len(routes) != 6 || len(response.Msg.Errors) != 6 || !response.Msg.SearchComplete {
		t.Fatalf("%+v", response.Msg)
	}
	expected := []string{"534", "3034", "1568", "4068", "6568", "9068"}
	for i, route := range routes {
		if route.AmountOutAtomic != expected[i] || route.DeploymentId != "uni" {
			t.Fatalf("route %d: %+v", i, route)
		}
		if i >= 2 && (len(route.Legs) != 2 || route.Legs[0].TokenOut != tokenB || route.Legs[1].TokenIn != tokenB) {
			t.Fatal("intermediate path changed")
		}
	}
	// Startup failure must not call the broken deployment, but must retain the healthy routes.
	chain := handler.Chains["test"]
	chain.DeploymentErrors = map[string]string{"pancake": "deployment verification failed"}
	handler.Chains["test"] = chain
	response, err = handler.GetQuote(context.Background(), connect.NewRequest(request))
	if err != nil || len(response.Msg.Routes) != 6 || len(response.Msg.Errors) != 1 || response.Msg.Errors[0].Message != "pancake: deployment verification failed" || response.Msg.Errors[0].RouteId != nil {
		t.Fatalf("isolation: %+v %v", response, err)
	}
}
