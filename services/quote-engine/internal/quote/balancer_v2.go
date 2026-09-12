package quote

import (
	"context"
	"errors"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"google.golang.org/protobuf/proto"
)

var balancerVaultABI = contractabi.BalancerVault
var balancerPoolABI = contractabi.BalancerPool

// queryBatchSwap requires FundManagement addresses even with external balances;
// this nonzero placeholder cannot authorize or receive an eth_call-only quote.
// https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/interfaces/contracts/vault/IVault.sol
var balancerQuerySender = common.HexToAddress("0x0000000000000000000000000000000000000001")

// Balancer V2 defines GIVEN_IN as 0 and its three pool specializations as 0-2.
// https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/interfaces/contracts/vault/IVault.sol
const (
	balancerGivenIn                uint8 = 0
	balancerLastPoolSpecialization uint8 = 2
)

// Dated fork and Tenderly evidence in epeius-development-log keeps this above
// the largest measured estimate without retaining the old 1.5M cap.
const balancerSwapGasLimit = "250000"

type balancerV2Quoter struct {
	reader     Reader
	id         string
	options    balancer.Options
	poolErrors map[string]bool
}

type balancerBatchSwapStep struct {
	PoolID                              [32]byte `abi:"poolId"`
	AssetInIndex, AssetOutIndex, Amount *big.Int
	UserData                            []byte
}

type balancerSingleSwap struct {
	PoolID            [32]byte `abi:"poolId"`
	Kind              uint8
	AssetIn, AssetOut common.Address
	Amount            *big.Int
	UserData          []byte
}

type balancerFunds struct {
	Sender              common.Address
	FromInternalBalance bool
	Recipient           common.Address
	ToInternalBalance   bool
}

func (q balancerV2Quoter) Candidates(r *quotev1.QuoteRequest, block *quotev1.BlockContext) func(context.Context) (QuoteCandidate, bool) {
	pools := append([]string(nil), q.options.Pools...)
	sort.Strings(pools)
	amount, _ := new(big.Int).SetString(r.AmountInAtomic, 10)
	return func(ctx context.Context) (QuoteCandidate, bool) {
		if len(pools) == 0 || ctx.Err() != nil {
			return QuoteCandidate{}, false
		}
		pool := pools[0]
		pools = pools[1:]
		id := q.id + ":" + pool
		return QuoteCandidate{ID: id, Quote: func(ctx context.Context) (*quotev1.RouteQuote, error) {
			start := time.Now()
			if q.poolErrors[pool] {
				return nil, errors.New("Balancer V2 pool verification failed")
			}
			output, eligible, err := quoteBalancerPool(ctx, q.reader, common.HexToAddress(q.options.Vault), common.HexToHash(pool), common.HexToAddress(r.TokenIn), common.HexToAddress(r.TokenOut), amount, common.HexToHash(block.Hash))
			if err != nil || !eligible {
				return nil, err
			}
			return &quotev1.RouteQuote{
				RouteId:         id,
				Provider:        "balancer-v2",
				DeploymentId:    q.id,
				Legs:            []*quotev1.RouteLeg{{Pool: pool, TokenIn: common.HexToAddress(r.TokenIn).Hex(), TokenOut: common.HexToAddress(r.TokenOut).Hex()}},
				AmountOutAtomic: output.String(),
				Block:           proto.CloneOf(block),
				LatencyMs:       uint32(time.Since(start).Milliseconds()),
			}, nil
		}}, true
	}
}

func (q balancerV2Quoter) Verify(ctx context.Context, hash common.Hash) error {
	reader, ok := q.reader.(codeReader)
	if !ok {
		return errors.New("deployment code unavailable")
	}
	vault := common.HexToAddress(q.options.Vault)
	code, err := reader.Code(ctx, vault, hash)
	if err != nil || len(code) == 0 {
		return errors.New("Balancer V2 Vault verification failed")
	}
	valid := 0
	for _, value := range q.options.Pools {
		if err := verifyBalancerPool(ctx, reader, vault, common.HexToHash(value), hash); err != nil {
			q.poolErrors[value] = true
			continue
		}
		valid++
		delete(q.poolErrors, value)
	}
	if valid == 0 {
		return errors.New("Balancer V2 pool verification failed")
	}
	return nil
}

func quoteBalancerPool(ctx context.Context, reader Reader, vault common.Address, poolID common.Hash, tokenIn, tokenOut common.Address, amount *big.Int, hash common.Hash) (*big.Int, bool, error) {
	tokens, err := balancerPoolTokens(ctx, reader, vault, poolID, hash)
	if err != nil {
		return nil, false, errors.New("Balancer V2 pool tokens unavailable")
	}
	poolAddress := balancerPoolAddress(poolID)
	hasIn, hasOut := false, false
	for _, token := range tokens {
		hasIn = hasIn || token == tokenIn
		hasOut = hasOut || token == tokenOut
	}
	if !hasIn || !hasOut || tokenIn == poolAddress || tokenOut == poolAddress {
		return nil, false, nil
	}
	data, err := balancerVaultABI.Pack("queryBatchSwap", balancerGivenIn, []balancerBatchSwapStep{{PoolID: poolID, AssetInIndex: big.NewInt(0), AssetOutIndex: big.NewInt(1), Amount: amount, UserData: []byte{}}}, []common.Address{tokenIn, tokenOut}, balancerFunds{Sender: balancerQuerySender, Recipient: balancerQuerySender})
	if err != nil {
		return nil, false, errors.New("Balancer V2 quote encoding failed")
	}
	raw, err := reader.Call(ctx, vault, data, hash)
	if err != nil {
		return nil, false, errors.New("Balancer V2 quote call failed")
	}
	values, err := evm.Unpack(balancerVaultABI.Methods["queryBatchSwap"], raw)
	if err != nil {
		return nil, false, errors.New("Balancer V2 quote result is invalid")
	}
	deltas, ok := values[0].([]*big.Int)
	if !ok || len(deltas) != 2 || deltas[0].Cmp(amount) != 0 || deltas[0].Sign() <= 0 || deltas[1].Sign() >= 0 {
		return nil, false, errors.New("Balancer V2 quote deltas are invalid")
	}
	output := new(big.Int).Neg(deltas[1])
	if output.Sign() <= 0 || output.BitLen() > 256 {
		return nil, false, errors.New("Balancer V2 quote output is invalid")
	}
	return output, true, nil
}

func balancerPoolTokens(ctx context.Context, reader Reader, vault common.Address, poolID common.Hash, hash common.Hash) ([]common.Address, error) {
	data, _ := balancerVaultABI.Pack("getPoolTokens", poolID)
	raw, err := reader.Call(ctx, vault, data, hash)
	if err != nil {
		return nil, err
	}
	values, err := evm.Unpack(balancerVaultABI.Methods["getPoolTokens"], raw)
	if err != nil {
		return nil, err
	}
	tokens, ok := values[0].([]common.Address)
	balances, balancesOK := values[1].([]*big.Int)
	if !ok || !balancesOK || len(tokens) == 0 || len(tokens) != len(balances) {
		return nil, errors.New("invalid pool tokens")
	}
	seen := map[common.Address]bool{}
	for _, token := range tokens {
		if token == (common.Address{}) || seen[token] {
			return nil, errors.New("invalid pool tokens")
		}
		seen[token] = true
	}
	return tokens, nil
}

func verifyBalancerPool(ctx context.Context, reader codeReader, vault common.Address, poolID common.Hash, hash common.Hash) error {
	data, _ := balancerVaultABI.Pack("getPool", poolID)
	raw, err := reader.Call(ctx, vault, data, hash)
	if err != nil {
		return err
	}
	values, err := evm.Unpack(balancerVaultABI.Methods["getPool"], raw)
	if err != nil {
		return err
	}
	pool, ok := values[0].(common.Address)
	specialization, specializationOK := values[1].(uint8)
	if !ok || !specializationOK || specialization > balancerLastPoolSpecialization || pool == (common.Address{}) || pool != balancerPoolAddress(poolID) {
		return errors.New("pool address mismatch")
	}
	code, err := reader.Code(ctx, pool, hash)
	if err != nil || len(code) == 0 {
		return errors.New("pool code unavailable")
	}
	data, _ = balancerPoolABI.Pack("getPoolId")
	raw, err = reader.Call(ctx, pool, data, hash)
	if err != nil {
		return err
	}
	values, err = evm.Unpack(balancerPoolABI.Methods["getPoolId"], raw)
	if err != nil {
		return err
	}
	returned, ok := values[0].([32]byte)
	if !ok || returned != poolID {
		return errors.New("pool ID mismatch")
	}
	_, err = balancerPoolTokens(ctx, reader, vault, poolID, hash)
	return err
}

func validBalancerRoute(route *quotev1.RouteQuote, id string, options balancer.Options) bool {
	if route == nil || route.Provider != "balancer-v2" || route.DeploymentId != id || len(route.Legs) != 1 {
		return false
	}
	leg := route.Legs[0]
	if leg.Selector != nil || !validAddress(leg.TokenIn) || !validAddress(leg.TokenOut) || strings.EqualFold(leg.TokenIn, leg.TokenOut) {
		return false
	}
	for _, pool := range options.Pools {
		if leg.Pool == pool {
			poolID := common.HexToHash(pool)
			poolAddress := balancerPoolAddress(poolID)
			return common.HexToAddress(leg.TokenIn) != poolAddress && common.HexToAddress(leg.TokenOut) != poolAddress
		}
	}
	return false
}

type balancerV2Preparation struct {
	id, chainID string
	options     balancer.Options
}

func (s balancerV2Preparation) Select(_ context.Context, _ storedQuote, _ *quotev1.PrepareExecutionRequest, route *quotev1.RouteQuote) (executionSelection, string) {
	if !validBalancerRoute(route, s.id, s.options) {
		return executionSelection{}, "unsupported route"
	}
	output, ok := new(big.Int).SetString(route.AmountOutAtomic, 10)
	if !ok || output.Sign() <= 0 || output.BitLen() > 256 {
		return executionSelection{}, "unsupported route"
	}
	return executionSelection{route: route, output: output}, ""
}

func (s balancerV2Preparation) Build(p *quotev1.PrepareExecutionResponse) (executionPlan, string) {
	amount, _ := new(big.Int).SetString(p.AmountInAtomic, 10)
	minimum, _ := new(big.Int).SetString(p.AmountOutMinimumAtomic, 10)
	if minimum.Sign() == 0 || !validBalancerRoute(p.Route, s.id, s.options) {
		return executionPlan{}, "unsupported route"
	}
	deadline, _ := strconv.ParseUint(p.DeadlineUnix, 10, 64)
	leg := p.Route.Legs[0]
	data, err := balancerVaultABI.Pack("swap", balancerSingleSwap{PoolID: common.HexToHash(leg.Pool), Kind: balancerGivenIn, AssetIn: common.HexToAddress(leg.TokenIn), AssetOut: common.HexToAddress(leg.TokenOut), Amount: amount, UserData: []byte{}}, balancerFunds{Sender: common.HexToAddress(p.Recipient), Recipient: common.HexToAddress(p.Recipient)}, minimum, new(big.Int).SetUint64(deadline))
	if err != nil {
		return executionPlan{}, "unsupported route"
	}
	vault := common.HexToAddress(s.options.Vault).Hex()
	tx := &quotev1.UnsignedTransaction{ChainId: s.chainID, To: vault, From: p.Recipient, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: balancerSwapGasLimit}
	checks := SimulationChecks{Input: BalanceProbe{leg.TokenIn, tx.From}, Output: BalanceProbe{leg.TokenOut, tx.From}}
	verify := func(ctx context.Context, reader Reader, hash common.Hash) string {
		code, ok := reader.(codeReader)
		if !ok || verifyBalancerPool(ctx, code, common.HexToAddress(s.options.Vault), common.HexToHash(leg.Pool), hash) != nil {
			return "Balancer V2 pool verification failed"
		}
		tokens, err := balancerPoolTokens(ctx, reader, common.HexToAddress(s.options.Vault), common.HexToHash(leg.Pool), hash)
		if err != nil {
			return "Balancer V2 pool verification failed"
		}
		hasIn, hasOut := false, false
		for _, token := range tokens {
			hasIn = hasIn || token == common.HexToAddress(leg.TokenIn)
			hasOut = hasOut || token == common.HexToAddress(leg.TokenOut)
		}
		if !hasIn || !hasOut {
			return "Balancer V2 pool verification failed"
		}
		return ""
	}
	return executionPlan{transaction: tx, spender: vault, checks: checks, verify: verify}, ""
}

// Balancer embeds the pool contract address in the first 20 bytes of poolId.
// https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/vault/contracts/PoolRegistry.sol
func balancerPoolAddress(poolID common.Hash) common.Address {
	return common.BytesToAddress(poolID[:20])
}
