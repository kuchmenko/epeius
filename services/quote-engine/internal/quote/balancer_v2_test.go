package quote

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"reflect"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
)

const (
	balancerVault  = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"
	stablePool     = "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063"
	weightedPool   = "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014"
	composablePool = "0x93d199263632a4ef4bb438f1feb99e57b4b5f0bd0000000000000000000005c2"
	dai            = "0x6b175474e89094c44da98b954eedeac495271d0f"
	usdc           = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
	bal            = "0xba100000625a3754423978a60c9317c58a424e3d"
	weth           = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
	wsteth         = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"
)

func balancerTokensResult(t *testing.T, tokens ...string) []byte {
	t.Helper()
	addresses := make([]common.Address, len(tokens))
	balances := make([]*big.Int, len(tokens))
	for i, token := range tokens {
		addresses[i] = common.HexToAddress(token)
		balances[i] = big.NewInt(int64(i + 1))
	}
	result, err := balancerVaultABI.Methods["getPoolTokens"].Outputs.Pack(addresses, balances, big.NewInt(1))
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestBalancerPinnedQuoteVectorsAndStrictSignedDeltas(t *testing.T) {
	fixtures := []struct {
		name, pool, in, out, amount, output string
	}{
		{"weighted BAL to WETH", weightedPool, bal, weth, "1000000000000000000", "1655948921020267"},
		{"weighted WETH to BAL", weightedPool, weth, bal, "1000000000000000000", "591835794858355497336"},
		{"stable DAI to USDC", stablePool, dai, usdc, "1000000000000000000", "1000023"},
		{"stable USDC to DAI", stablePool, usdc, dai, "1000000", "999876305476793362"},
		{"composable wstETH to WETH", composablePool, wsteth, weth, "1000000000000000000", "1152933356389882853"},
		{"composable WETH to wstETH", composablePool, weth, wsteth, "1000000000000000000", "867178645851903897"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			amount, _ := new(big.Int).SetString(fixture.amount, 10)
			want, _ := new(big.Int).SetString(fixture.output, 10)
			calls := 0
			reader := readerFake{call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
				if to != common.HexToAddress(balancerVault) || hash != common.HexToHash(blockHash) {
					t.Fatal("call not pinned to configured Vault")
				}
				calls++
				switch {
				case bytes.Equal(data[:4], crypto.Keccak256([]byte("getPoolTokens(bytes32)"))[:4]):
					return balancerTokensResult(t, fixture.in, fixture.out), nil
				case bytes.Equal(data[:4], crypto.Keccak256([]byte("queryBatchSwap(uint8,(bytes32,uint256,uint256,uint256,bytes)[],address[],(address,bool,address,bool))"))[:4]):
					return balancerVaultABI.Methods["queryBatchSwap"].Outputs.Pack([]*big.Int{new(big.Int).Set(amount), new(big.Int).Neg(want)})
				default:
					return nil, errors.New("unexpected call")
				}
			}}
			got, eligible, err := quoteBalancerPool(context.Background(), reader, common.HexToAddress(balancerVault), common.HexToHash(fixture.pool), common.HexToAddress(fixture.in), common.HexToAddress(fixture.out), amount, common.HexToHash(blockHash))
			if err != nil || !eligible || got.Cmp(want) != 0 || calls != 2 {
				t.Fatalf("got %v eligible=%v calls=%d error=%v", got, eligible, calls, err)
			}
		})
	}

	amount := big.NewInt(100)
	for _, deltas := range [][]*big.Int{
		{big.NewInt(-100), big.NewInt(-90)},
		{big.NewInt(99), big.NewInt(-90)},
		{big.NewInt(100), big.NewInt(90)},
		{big.NewInt(100)},
	} {
		reader := readerFake{call: func(_ context.Context, _ common.Address, data []byte, _ common.Hash) ([]byte, error) {
			if bytes.Equal(data[:4], crypto.Keccak256([]byte("getPoolTokens(bytes32)"))[:4]) {
				return balancerTokensResult(t, dai, usdc), nil
			}
			return balancerVaultABI.Methods["queryBatchSwap"].Outputs.Pack(deltas)
		}}
		if _, _, err := quoteBalancerPool(context.Background(), reader, common.HexToAddress(balancerVault), common.HexToHash(stablePool), common.HexToAddress(dai), common.HexToAddress(usdc), amount, common.HexToHash(blockHash)); err == nil {
			t.Fatalf("invalid deltas accepted: %v", deltas)
		}
	}
}

func TestBalancerPoolMembershipAndBPTExclusion(t *testing.T) {
	poolID := common.HexToHash(stablePool)
	poolAddress := common.BytesToAddress(poolID[:20]).Hex()
	for _, pair := range [][2]string{{dai, weth}, {poolAddress, dai}} {
		calls := 0
		reader := readerFake{call: func(_ context.Context, _ common.Address, _ []byte, _ common.Hash) ([]byte, error) {
			calls++
			return balancerTokensResult(t, dai, usdc, poolAddress), nil
		}}
		output, eligible, err := quoteBalancerPool(context.Background(), reader, common.HexToAddress(balancerVault), common.HexToHash(stablePool), common.HexToAddress(pair[0]), common.HexToAddress(pair[1]), big.NewInt(1), common.HexToHash(blockHash))
		if err != nil || eligible || output != nil || calls != 1 {
			t.Fatalf("unsupported pair was quoted: %v %v %v", output, eligible, err)
		}
	}
}

func TestBalancerIdentityVerificationUsesFullPoolID(t *testing.T) {
	poolID := common.HexToHash(stablePool)
	pool := common.BytesToAddress(poolID[:20])
	getPool, _ := balancerVaultABI.Methods["getPool"].Outputs.Pack(pool, uint8(0))
	getPoolID, _ := balancerPoolABI.Methods["getPoolId"].Outputs.Pack(poolID)
	reader := codeFake{
		code: func(_ context.Context, address common.Address, hash common.Hash) ([]byte, error) {
			if address != pool || hash != common.HexToHash(blockHash) {
				t.Fatal("pool code check changed")
			}
			return []byte{1}, nil
		},
		readerFake: readerFake{call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
			if hash != common.HexToHash(blockHash) {
				t.Fatal("identity call not pinned")
			}
			switch {
			case to == common.HexToAddress(balancerVault) && bytes.Equal(data[:4], crypto.Keccak256([]byte("getPool(bytes32)"))[:4]):
				return getPool, nil
			case to == pool && bytes.Equal(data[:4], crypto.Keccak256([]byte("getPoolId()"))[:4]):
				return getPoolID, nil
			default:
				return balancerTokensResult(t, dai, usdc), nil
			}
		}},
	}
	if err := verifyBalancerPool(context.Background(), reader, common.HexToAddress(balancerVault), poolID, common.HexToHash(blockHash)); err != nil {
		t.Fatal(err)
	}
	altered := poolID
	altered[31]++
	if err := verifyBalancerPool(context.Background(), reader, common.HexToAddress(balancerVault), altered, common.HexToHash(blockHash)); err == nil {
		t.Fatal("altered full pool ID accepted")
	}
}

func TestBalancerFailedPoolDoesNotDisableHealthyPool(t *testing.T) {
	stableID := common.HexToHash(stablePool)
	stableAddress := common.BytesToAddress(stableID[:20])
	getPool, _ := balancerVaultABI.Methods["getPool"].Outputs.Pack(stableAddress, uint8(0))
	getPoolID, _ := balancerPoolABI.Methods["getPoolId"].Outputs.Pack(stableID)
	reader := codeFake{
		code: func(_ context.Context, address common.Address, _ common.Hash) ([]byte, error) {
			if address != common.HexToAddress(balancerVault) && address != stableAddress {
				return nil, errors.New("missing code")
			}
			return []byte{1}, nil
		},
		readerFake: readerFake{call: func(_ context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
			switch {
			case to == common.HexToAddress(balancerVault) && bytes.Equal(data[:4], crypto.Keccak256([]byte("getPool(bytes32)"))[:4]):
				if common.BytesToHash(data[4:]) != stableID {
					return nil, errors.New("bad pool")
				}
				return getPool, nil
			case to == stableAddress && bytes.Equal(data[:4], crypto.Keccak256([]byte("getPoolId()"))[:4]):
				return getPoolID, nil
			case bytes.Equal(data[:4], crypto.Keccak256([]byte("getPoolTokens(bytes32)"))[:4]):
				return balancerTokensResult(t, dai, usdc), nil
			case bytes.Equal(data[:4], crypto.Keccak256([]byte("queryBatchSwap(uint8,(bytes32,uint256,uint256,uint256,bytes)[],address[],(address,bool,address,bool))"))[:4]):
				return balancerVaultABI.Methods["queryBatchSwap"].Outputs.Pack([]*big.Int{big.NewInt(100), big.NewInt(-90)})
			default:
				return nil, errors.New("unexpected call")
			}
		}},
	}
	quoter := balancerV2Quoter{
		reader:     reader,
		id:         "balancer",
		options:    balancer.Options{Vault: balancerVault, Pools: []string{weightedPool, stablePool}},
		poolErrors: map[string]bool{},
	}
	if err := quoter.Verify(context.Background(), common.HexToHash(blockHash)); err != nil {
		t.Fatal("healthy pool did not keep deployment available", err)
	}
	if quoter.poolErrors[stablePool] || !quoter.poolErrors[weightedPool] {
		t.Fatal("pool verification results were not isolated", quoter.poolErrors)
	}
	next := quoter.Candidates(&quotev1.QuoteRequest{TokenIn: dai, TokenOut: usdc, AmountInAtomic: "100"}, &quotev1.BlockContext{Hash: blockHash})
	healthy, ok := next(context.Background())
	if !ok || healthy.ID != "balancer:"+stablePool {
		t.Fatal("healthy candidate missing", healthy.ID)
	}
	route, err := healthy.Quote(context.Background())
	if err != nil || route.AmountOutAtomic != "90" {
		t.Fatal("healthy candidate failed", route, err)
	}
	failed, ok := next(context.Background())
	if !ok || failed.ID != "balancer:"+weightedPool {
		t.Fatal("failed candidate missing", failed.ID)
	}
	if _, err := failed.Quote(context.Background()); err == nil {
		t.Fatal("failed pool became quotable")
	}
}

func TestBalancerPreparationMatchesIndependentCastCalldataAndHasNoVaultProbe(t *testing.T) {
	options := balancer.Options{Vault: balancerVault, Pools: []string{stablePool}}
	route := &quotev1.RouteQuote{Provider: "balancer-v2", DeploymentId: "balancer", AmountOutAtomic: "1000023", Legs: []*quotev1.RouteLeg{{Pool: stablePool, TokenIn: dai, TokenOut: usdc}}}
	p := &quotev1.PrepareExecutionResponse{Route: route, Recipient: "0x1111111111111111111111111111111111111111", AmountInAtomic: "1000000000000000000", AmountOutMinimumAtomic: "995022", DeadlineUnix: "1700000000"}
	strategy := balancerV2Preparation{id: "balancer", chainID: "1", options: options}
	selection, message := strategy.Select(context.Background(), storedQuote{}, nil, route)
	if message != "" || selection.output.String() != "1000023" {
		t.Fatal("route rejected", message)
	}
	plan, message := strategy.Build(p)
	if message != "" {
		t.Fatal(message)
	}
	const castCalldata = "0x52bbbe2900000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f2ece000000000000000000000000000000000000000000000000000000006553f10006df3b2bbb68adc8b0e302443692037ed9f91b4200000000000000000000006300000000000000000000000000000000000000000000000000000000000000000000000000000000000000006b175474e89094c44da98b954eedeac495271d0f000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000"
	if plan.transaction.Data != castCalldata || plan.transaction.To != common.HexToAddress(balancerVault).Hex() || plan.transaction.GasLimit != "250000" || plan.spender != common.HexToAddress(balancerVault).Hex() {
		t.Fatalf("wrong prepared transaction: %+v", plan.transaction)
	}
	wantChecks := SimulationChecks{Input: BalanceProbe{dai, p.Recipient}, Output: BalanceProbe{usdc, p.Recipient}}
	if !reflect.DeepEqual(plan.checks, wantChecks) || len(plan.checks.Preserve) != 0 {
		t.Fatalf("Vault custody was treated as residue: %+v", plan.checks)
	}

	for _, mutate := range []func(*quotev1.RouteQuote){
		func(r *quotev1.RouteQuote) { r.Legs[0].Pool = weightedPool },
		func(r *quotev1.RouteQuote) { r.Legs[0].Pool = r.Legs[0].Pool[:42] },
		func(r *quotev1.RouteQuote) { r.Legs[0].Selector = &quotev1.RouteLeg_FeePips{FeePips: 0} },
		func(r *quotev1.RouteQuote) { r.Legs = append(r.Legs, r.Legs[0]) },
	} {
		changed := &quotev1.RouteQuote{Provider: route.Provider, DeploymentId: route.DeploymentId, AmountOutAtomic: route.AmountOutAtomic, Legs: []*quotev1.RouteLeg{{Pool: route.Legs[0].Pool, TokenIn: route.Legs[0].TokenIn, TokenOut: route.Legs[0].TokenOut}}}
		mutate(changed)
		if _, message := strategy.Select(context.Background(), storedQuote{}, nil, changed); message == "" {
			t.Fatal("mutated route accepted")
		}
	}
}
