package quote

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"sort"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
	"google.golang.org/protobuf/proto"
)

var (
	atomicCandidateProviderDomain    = crypto.Keccak256Hash([]byte("Epeius.AtomicProvider.v1"))
	atomicCandidateOperationDomain   = crypto.Keccak256Hash([]byte("Epeius.AtomicOperation.v1"))
	atomicCandidateBranchDomain      = crypto.Keccak256Hash([]byte("Epeius.AtomicProgramBranch.v1"))
	atomicCandidateProgramDomain     = crypto.Keccak256Hash([]byte("Epeius.AtomicProgram.v1"))
	atomicCandidateQuoteBranchDomain = crypto.Keccak256Hash([]byte("Epeius.AtomicCandidateBranch.v1"))
	atomicCandidateDomain            = crypto.Keccak256Hash([]byte("Epeius.AtomicCandidate.v1"))
)

func atomicV3Pool(operation *atomicv1.PoolOperation) (*atomicv1.V3Pool, uint8) {
	if operation == nil {
		return nil, 0
	}
	if pool := operation.GetUniswapV3(); pool != nil {
		return pool, 1
	}
	if pool := operation.GetPancakeV3(); pool != nil {
		return pool, 2
	}
	return nil, 0
}

type atomicPoolIdentity struct {
	factory, router, pool []byte
	vault, poolID         []byte
	manager, currency0    []byte
	currency1, hooks      []byte
	selector              *big.Int
	spacing               *big.Int
	kind                  uint8
	slipstream            bool
	balancer              bool
	v4                    bool
}

func atomicPool(operation *atomicv1.PoolOperation) (atomicPoolIdentity, bool) {
	if pool, kind := atomicV3Pool(operation); pool != nil {
		return atomicPoolIdentity{factory: pool.Factory, router: pool.Router, pool: pool.Pool, selector: new(big.Int).SetUint64(uint64(pool.GetFeePips())), kind: kind}, true
	}
	if operation != nil {
		if pool := operation.GetSlipstreamInitial(); pool != nil && pool.TickSpacing != nil {
			return atomicPoolIdentity{factory: pool.Factory, router: pool.Router, pool: pool.Pool, selector: big.NewInt(int64(pool.GetTickSpacing())), kind: 3, slipstream: true}, true
		}
		if pool := operation.GetBalancerV2(); pool != nil {
			return atomicPoolIdentity{vault: pool.Vault, poolID: pool.PoolId, kind: 4, balancer: true}, true
		}
		if pool := operation.GetUniswapV4(); pool != nil && pool.Key != nil && pool.Key.FeePips != nil && pool.Key.TickSpacing != nil {
			return atomicPoolIdentity{
				manager: pool.PoolManager, currency0: pool.Key.Currency0, currency1: pool.Key.Currency1,
				hooks: pool.Key.Hooks, selector: new(big.Int).SetUint64(uint64(pool.Key.GetFeePips())),
				spacing: big.NewInt(int64(pool.Key.GetTickSpacing())), kind: 5, v4: true,
			}, true
		}
	}
	return atomicPoolIdentity{}, false
}

func uint256Bytes(value *big.Int) []byte {
	return common.LeftPadBytes(value.Bytes(), 32)
}

func atomicCandidateHash(program *atomicv1.PlanProgram, block *atomicv1.PinnedBlock, quotes []*atomicv1.BranchQuote) (common.Hash, error) {
	uint8Type, uint24Type, int24Type := atomicABIType("uint8"), atomicABIType("uint24"), atomicABIType("int24")
	uint32Type, uint256Type := atomicABIType("uint32"), atomicABIType("uint256")
	addressType, bytes32Type := atomicABIType("address"), atomicABIType("bytes32")
	bytes32ArrayType := atomicABIType("bytes32[]")
	uint256ArrayType := atomicABIType("uint256[]")

	branchHashes := make([]common.Hash, len(program.Branches))
	if len(quotes) != len(program.Branches) {
		return common.Hash{}, errors.New("branch quote count does not match program")
	}
	for i, branch := range program.Branches {
		operationHashes := make([]common.Hash, len(branch.Operations))
		if quotes[i] == nil || len(quotes[i].OperationOutputs) != len(branch.Operations) {
			return common.Hash{}, errors.New("operation output count does not match program")
		}
		for j, operation := range branch.Operations {
			pool, ok := atomicPool(operation)
			if !ok {
				return common.Hash{}, errors.New("unsupported operation")
			}
			selectorType := uint24Type
			if pool.slipstream {
				selectorType = int24Type
			}
			var providerHash common.Hash
			var err error
			if pool.balancer {
				providerHash, err = atomicHash(abi.Arguments{{Type: bytes32Type}, {Type: uint8Type}, {Type: addressType}, {Type: bytes32Type}}, atomicCandidateProviderDomain, pool.kind, common.BytesToAddress(pool.vault), common.BytesToHash(pool.poolID))
			} else if pool.v4 {
				providerHash, err = atomicHash(
					abi.Arguments{{Type: bytes32Type}, {Type: uint8Type}, {Type: addressType}, {Type: addressType}, {Type: addressType}, {Type: uint24Type}, {Type: int24Type}, {Type: addressType}},
					atomicCandidateProviderDomain, pool.kind, common.BytesToAddress(pool.manager), common.BytesToAddress(pool.currency0), common.BytesToAddress(pool.currency1), pool.selector, pool.spacing, common.BytesToAddress(pool.hooks),
				)
			} else {
				providerHash, err = atomicHash(
					abi.Arguments{{Type: bytes32Type}, {Type: uint8Type}, {Type: addressType}, {Type: addressType}, {Type: addressType}, {Type: selectorType}},
					atomicCandidateProviderDomain, pool.kind, common.BytesToAddress(pool.factory), common.BytesToAddress(pool.router), common.BytesToAddress(pool.pool), pool.selector,
				)
			}
			if err != nil {
				return common.Hash{}, err
			}
			operationHashes[j], err = atomicHash(
				abi.Arguments{{Type: bytes32Type}, {Type: uint8Type}, {Type: addressType}, {Type: addressType}, {Type: bytes32Type}},
				atomicCandidateOperationDomain, pool.kind, common.BytesToAddress(operation.TokenIn), common.BytesToAddress(operation.TokenOut), providerHash,
			)
			if err != nil {
				return common.Hash{}, err
			}
		}
		amount := new(big.Int).SetBytes(branch.AmountIn)
		var err error
		branchHashes[i], err = atomicHash(abi.Arguments{{Type: bytes32Type}, {Type: uint256Type}, {Type: bytes32ArrayType}}, atomicCandidateBranchDomain, amount, operationHashes)
		if err != nil {
			return common.Hash{}, err
		}
	}
	programHash, err := atomicHash(
		abi.Arguments{{Type: bytes32Type}, {Type: uint32Type}, {Type: uint256Type}, {Type: addressType}, {Type: addressType}, {Type: uint256Type}, {Type: bytes32ArrayType}},
		atomicCandidateProgramDomain, uint32(1), new(big.Int).SetBytes(program.ChainId), common.BytesToAddress(program.TokenIn), common.BytesToAddress(program.TokenOut), new(big.Int).SetBytes(program.AmountIn), branchHashes,
	)
	if err != nil {
		return common.Hash{}, err
	}
	quoteHashes := make([]common.Hash, len(quotes))
	for i, quote := range quotes {
		outputs := make([]*big.Int, len(quote.OperationOutputs))
		for j, output := range quote.OperationOutputs {
			outputs[j] = new(big.Int).SetBytes(output)
		}
		quoteHashes[i], err = atomicHash(abi.Arguments{{Type: bytes32Type}, {Type: uint256ArrayType}}, atomicCandidateQuoteBranchDomain, outputs)
		if err != nil {
			return common.Hash{}, err
		}
	}
	return atomicHash(
		abi.Arguments{{Type: bytes32Type}, {Type: bytes32Type}, {Type: uint256Type}, {Type: bytes32Type}, {Type: bytes32ArrayType}},
		atomicCandidateDomain, programHash, new(big.Int).SetBytes(block.Number), common.BytesToHash(block.Hash), quoteHashes,
	)
}

func atomicV4Candidate(chainID, amount *big.Int, tokenIn, tokenOut common.Address, options uniswapv4.Options, pool uniswapv4.Pool, block *atomicv1.PinnedBlock, output *big.Int) (*atomicv1.PlanCandidate, error) {
	operation := &atomicv1.PoolOperation{
		TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(),
		Pool: &atomicv1.PoolOperation_UniswapV4{UniswapV4: &atomicv1.V4Pool{
			PoolManager: common.HexToAddress(options.PoolManager).Bytes(),
			Key: &atomicv1.V4PoolKey{
				Currency0: common.HexToAddress(pool.Currency0).Bytes(), Currency1: common.HexToAddress(pool.Currency1).Bytes(),
				FeePips: proto.Uint32(pool.FeePips), TickSpacing: proto.Int32(pool.TickSpacing), Hooks: common.HexToAddress(pool.Hooks).Bytes(),
			},
		}},
	}
	program := &atomicv1.PlanProgram{FormatVersion: proto.Uint32(1), ChainId: uint256Bytes(chainID), TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(), AmountIn: uint256Bytes(amount), Branches: []*atomicv1.PlanBranch{{AmountIn: uint256Bytes(amount), Operations: []*atomicv1.PoolOperation{operation}}}}
	quotes := []*atomicv1.BranchQuote{{OperationOutputs: [][]byte{uint256Bytes(output)}}}
	hash, err := atomicCandidateHash(program, block, quotes)
	if err != nil {
		return nil, err
	}
	return &atomicv1.PlanCandidate{CandidateId: hash.Bytes(), Program: program, QuoteBlock: proto.CloneOf(block), BranchQuotes: quotes}, nil
}

func atomicBalancerCandidate(chainID, amount *big.Int, tokenIn, tokenOut, vault common.Address, poolID common.Hash, block *atomicv1.PinnedBlock, output *big.Int) (*atomicv1.PlanCandidate, error) {
	operation := &atomicv1.PoolOperation{TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(), Pool: &atomicv1.PoolOperation_BalancerV2{BalancerV2: &atomicv1.BalancerPool{Vault: vault.Bytes(), PoolId: poolID.Bytes()}}}
	program := &atomicv1.PlanProgram{FormatVersion: proto.Uint32(1), ChainId: uint256Bytes(chainID), TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(), AmountIn: uint256Bytes(amount), Branches: []*atomicv1.PlanBranch{{AmountIn: uint256Bytes(amount), Operations: []*atomicv1.PoolOperation{operation}}}}
	quotes := []*atomicv1.BranchQuote{{OperationOutputs: [][]byte{uint256Bytes(output)}}}
	hash, err := atomicCandidateHash(program, block, quotes)
	if err != nil {
		return nil, err
	}
	return &atomicv1.PlanCandidate{CandidateId: hash.Bytes(), Program: program, QuoteBlock: proto.CloneOf(block), BranchQuotes: quotes}, nil
}

func atomicPlanCandidate(chainID, amount *big.Int, tokenIn, tokenOut common.Address, deployment config.Deployment, item candidate, block *atomicv1.PinnedBlock, outputs []*big.Int, legsPools []common.Address) (*atomicv1.PlanCandidate, error) {
	operationCount := len(item.fees)
	if deployment.Kind == "aerodrome-slipstream" {
		operationCount = len(item.spacings)
	}
	operations := make([]*atomicv1.PoolOperation, operationCount)
	seenPools := map[common.Address]bool{}
	seenKeys := map[string]bool{}
	for i := range operations {
		pool := legsPools[i]
		fee := uint32(0)
		spacing := int32(0)
		if deployment.Kind == "aerodrome-slipstream" {
			spacing = item.spacings[i]
		} else {
			fee = item.fees[i]
		}
		kind := uint8(1)
		if deployment.Kind == "pancake-v3" {
			kind = 2
		} else if deployment.Kind == "aerodrome-slipstream" {
			kind = 3
		}
		key := atomicV1PoolKeyFromValues(kind, item.tokens[i], item.tokens[i+1], fee, spacing)
		if seenPools[pool] || seenKeys[key] {
			return nil, nil
		}
		seenPools[pool], seenKeys[key] = true, true
		operation := &atomicv1.PoolOperation{
			TokenIn: item.tokens[i].Bytes(), TokenOut: item.tokens[i+1].Bytes(),
		}
		if deployment.Kind == "aerodrome-slipstream" {
			operation.Pool = &atomicv1.PoolOperation_SlipstreamInitial{SlipstreamInitial: &atomicv1.SlipstreamPool{Factory: common.HexToAddress(deployment.Factory).Bytes(), Router: common.HexToAddress(deployment.Router).Bytes(), Pool: pool.Bytes(), TickSpacing: proto.Int32(spacing)}}
		} else if deployment.Kind == "pancake-v3" {
			poolValue := &atomicv1.V3Pool{Factory: common.HexToAddress(deployment.Factory).Bytes(), Router: common.HexToAddress(deployment.Router).Bytes(), Pool: pool.Bytes(), FeePips: proto.Uint32(fee)}
			operation.Pool = &atomicv1.PoolOperation_PancakeV3{PancakeV3: poolValue}
		} else {
			poolValue := &atomicv1.V3Pool{Factory: common.HexToAddress(deployment.Factory).Bytes(), Router: common.HexToAddress(deployment.Router).Bytes(), Pool: pool.Bytes(), FeePips: proto.Uint32(fee)}
			operation.Pool = &atomicv1.PoolOperation_UniswapV3{UniswapV3: poolValue}
		}
		operations[i] = operation
	}
	operationOutputs := make([][]byte, len(outputs))
	for i, output := range outputs {
		if output == nil || output.Sign() <= 0 || output.BitLen() > 256 {
			return nil, nil
		}
		operationOutputs[i] = uint256Bytes(output)
	}
	program := &atomicv1.PlanProgram{
		FormatVersion: proto.Uint32(1), ChainId: uint256Bytes(chainID), TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(), AmountIn: uint256Bytes(amount),
		Branches: []*atomicv1.PlanBranch{{AmountIn: uint256Bytes(amount), Operations: operations}},
	}
	branchQuotes := []*atomicv1.BranchQuote{{OperationOutputs: operationOutputs}}
	hash, err := atomicCandidateHash(program, block, branchQuotes)
	if err != nil {
		return nil, err
	}
	return &atomicv1.PlanCandidate{CandidateId: hash.Bytes(), Program: program, QuoteBlock: proto.CloneOf(block), BranchQuotes: branchQuotes}, nil
}

func atomicV1PoolKeyFromValues(kind uint8, in, out common.Address, fee uint32, spacing int32) string {
	if string(in[:]) > string(out[:]) {
		in, out = out, in
	}
	selector := new(big.Int).SetUint64(uint64(fee))
	if kind == 3 {
		selector.SetInt64(int64(spacing))
	}
	return string([]byte{kind}) + string(in[:]) + string(out[:]) + selector.String()
}

func (h Handler) GetPlanQuote(ctx context.Context, req *connect.Request[atomicv1.PlanQuoteRequest]) (*connect.Response[atomicv1.PlanQuoteResponse], error) {
	invalid := func(message string) (*connect.Response[atomicv1.PlanQuoteResponse], error) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New(message))
	}
	if h.QuoteConcurrency < 1 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("quote concurrency is not configured"))
	}
	r := req.Msg
	if r == nil || len(r.ProtoReflect().GetUnknown()) != 0 || r.FormatVersion == nil || r.GetFormatVersion() != 1 || len(r.ChainId) != 32 || len(r.TokenIn) != 20 || len(r.TokenOut) != 20 || len(r.AmountIn) != 32 || r.SearchBudgetMs == nil || r.GetSearchBudgetMs() == 0 {
		return invalid("invalid Atomic V1 quote request")
	}
	chainID, amount := new(big.Int).SetBytes(r.ChainId), new(big.Int).SetBytes(r.AmountIn)
	tokenIn, tokenOut := common.BytesToAddress(r.TokenIn), common.BytesToAddress(r.TokenOut)
	if chainID.Sign() <= 0 || amount.Sign() <= 0 || tokenIn == tokenOut {
		return invalid("invalid Atomic V1 quote request")
	}
	var chain Chain
	var chainKey string
	matches := 0
	for key, configured := range h.Chains {
		if configured.ChainID == chainID.String() {
			chain, chainKey, matches = configured, key, matches+1
		}
	}
	if matches != 1 {
		return invalid("chain ID must identify exactly one configured chain")
	}
	allowed := map[common.Address]bool{}
	for _, token := range chain.Config.Tokens {
		allowed[common.HexToAddress(token.Address)] = true
	}
	if !allowed[tokenIn] || !allowed[tokenOut] {
		return invalid("pair must contain distinct configured tokens")
	}
	if chain.Client == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("chain is unavailable"))
	}
	executor := chain.Config.AtomicExecutor
	if executor == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("Atomic V1 executor is not configured"))
	}
	deployments := map[string]config.Deployment{}
	for id, kind := range map[string]string{executor.UniswapDeployment: "uniswap-v3", executor.PancakeDeployment: "pancake-v3", executor.SlipstreamDeployment: "aerodrome-slipstream", executor.BalancerDeployment: "balancer-v2", executor.UniswapV4Deployment: "uniswap-v4"} {
		deployment, ok := chain.Config.Deployments[id]
		if id != "" && ok && deployment.Kind == kind && chain.DeploymentErrors[id] == "" {
			deployments[id] = deployment
		}
	}
	if len(deployments) == 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("Atomic V1 deployments are unavailable"))
	}

	searchCtx, cancel := context.WithTimeout(ctx, time.Duration(r.GetSearchBudgetMs())*time.Millisecond)
	defer cancel()
	snapshot, err := chain.Client.Snapshot(searchCtx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, connect.NewError(contextCode(ctx.Err()), ctx.Err())
		}
		if searchCtx.Err() != nil {
			return nil, connect.NewError(connect.CodeDeadlineExceeded, errors.New("search budget expired before snapshot"))
		}
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("could not read quote block"))
	}
	blockNumber, ok := new(big.Int).SetString(snapshot.BlockNumber, 10)
	if !ok || blockNumber.Sign() < 0 || blockNumber.BitLen() > 256 || !common.IsHexHash(snapshot.BlockHash) {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("invalid quote block"))
	}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(snapshot.BlockHash).Bytes()}
	type workItem struct {
		deployment string
		candidate  candidate
		poolID     common.Hash
		v4Pool     *uniswapv4.Pool
	}
	var deploymentIDs []string
	for id := range deployments {
		deploymentIDs = append(deploymentIDs, id)
	}
	sort.Strings(deploymentIDs)
	var work []workItem
	for _, id := range deploymentIDs {
		deployment := deployments[id]
		if deployment.Kind == "balancer-v2" {
			options, ok := deployment.ProviderConfig.(balancer.Options)
			if !ok {
				continue
			}
			pools := append([]string(nil), options.Pools...)
			sort.Strings(pools)
			for _, pool := range pools {
				work = append(work, workItem{deployment: id, poolID: common.HexToHash(pool)})
			}
			continue
		}
		if deployment.Kind == "uniswap-v4" {
			options, ok := deployment.ProviderConfig.(uniswapv4.Options)
			if !ok {
				continue
			}
			pools := append([]uniswapv4.Pool(nil), options.Pools...)
			sort.Slice(pools, func(i, j int) bool {
				left, _ := uniswapv4.PoolID(v4PoolKey(pools[i]))
				right, _ := uniswapv4.PoolID(v4PoolKey(pools[j]))
				return left.Hex() < right.Hex()
			})
			for i := range pools {
				if (common.HexToAddress(pools[i].Currency0) == tokenIn && common.HexToAddress(pools[i].Currency1) == tokenOut) || (common.HexToAddress(pools[i].Currency1) == tokenIn && common.HexToAddress(pools[i].Currency0) == tokenOut) {
					pool := pools[i]
					work = append(work, workItem{deployment: id, v4Pool: &pool})
				}
			}
			continue
		}
		iterator := newCandidates(config.Chain{Tokens: chain.Config.Tokens, Deployments: map[string]config.Deployment{id: deployment}}, tokenIn, tokenOut)
		for {
			_, item, exists := iterator.next(searchCtx)
			if !exists {
				break
			}
			work = append(work, workItem{deployment: id, candidate: item})
		}
	}
	var workMu sync.Mutex
	nextWork := 0
	takeWork := func() (int, workItem, bool) {
		workMu.Lock()
		defer workMu.Unlock()
		if nextWork >= len(work) || searchCtx.Err() != nil {
			return 0, workItem{}, false
		}
		index := nextWork
		nextWork++
		return index, work[index], true
	}
	type originCheck struct {
		once sync.Once
		err  error
	}
	originChecks := map[string]*originCheck{}
	for id, deployment := range deployments {
		if deployment.Kind == "aerodrome-slipstream" {
			originChecks[id] = &originCheck{}
		}
	}
	type result struct {
		index int
		value *atomicv1.PlanCandidate
	}
	results := make(chan result)
	var workers sync.WaitGroup
	for range h.QuoteConcurrency {
		index, atomicWork, exists := takeWork()
		if !exists {
			break
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				deployment := deployments[atomicWork.deployment]
				item := atomicWork.candidate
				var legs []*quotev1.RouteLeg
				var outputs []*big.Int
				var quoteErr error
				if deployment.Kind == "balancer-v2" {
					options, _ := deployment.ProviderConfig.(balancer.Options)
					var output *big.Int
					if !atomicBalancerPair(searchCtx, chain.Client, common.HexToAddress(options.Vault), atomicWork.poolID, tokenIn, tokenOut, common.HexToHash(snapshot.BlockHash)) {
						quoteErr = errors.New("Balancer V2 pool is not an exact pair")
					} else {
						output, _, quoteErr = quoteBalancerPoolWithSender(searchCtx, chain.Client, common.HexToAddress(options.Vault), atomicWork.poolID, tokenIn, tokenOut, amount, common.HexToHash(snapshot.BlockHash), common.HexToAddress(executor.Address))
					}
					if quoteErr == nil && output != nil {
						outputs = []*big.Int{output}
					}
				} else if deployment.Kind == "uniswap-v4" {
					options, _ := deployment.ProviderConfig.(uniswapv4.Options)
					var route *quotev1.RouteQuote
					route, quoteErr = (v4Quoter{reader: chain.Client, id: atomicWork.deployment, deployment: deployment, options: options}).quote(searchCtx, atomicWork.deployment, *atomicWork.v4Pool, tokenIn, tokenOut, amount, &quotev1.BlockContext{Number: snapshot.BlockNumber, Hash: snapshot.BlockHash})
					if quoteErr == nil && route != nil {
						output, ok := new(big.Int).SetString(route.AmountOutAtomic, 10)
						if ok && output.Sign() > 0 && output.BitLen() <= 256 {
							outputs = []*big.Int{output}
						} else {
							quoteErr = errors.New("invalid Uniswap V4 output")
						}
					}
				} else if deployment.Kind == "aerodrome-slipstream" {
					check := originChecks[atomicWork.deployment]
					check.once.Do(func() {
						check.err = verifySlipstreamQuoteOrigin(searchCtx, chain.Client, common.HexToHash(snapshot.BlockHash), common.HexToAddress(deployment.Factory))
					})
					quoteErr = check.err
					if quoteErr == nil {
						options, _ := deployment.ProviderConfig.(slipstream.Options)
						legs, outputs, quoteErr = (slipstreamQuoter{reader: chain.Client, deployment: deployment, options: options}).quoteOutputs(searchCtx, item.tokens, item.spacings, amount, common.HexToHash(snapshot.BlockHash))
					}
				} else {
					legs, outputs, quoteErr = quotePathOutputs(searchCtx, chain.Client, deployment, item.tokens, item.fees, amount, common.HexToHash(snapshot.BlockHash))
				}
				var value *atomicv1.PlanCandidate
				expectedLegs := len(item.fees)
				if deployment.Kind == "aerodrome-slipstream" {
					expectedLegs = len(item.spacings)
				}
				if deployment.Kind == "balancer-v2" && quoteErr == nil && len(outputs) == 1 {
					options, _ := deployment.ProviderConfig.(balancer.Options)
					value, _ = atomicBalancerCandidate(chainID, amount, tokenIn, tokenOut, common.HexToAddress(options.Vault), atomicWork.poolID, block, outputs[0])
				} else if deployment.Kind == "uniswap-v4" && quoteErr == nil && len(outputs) == 1 {
					options, _ := deployment.ProviderConfig.(uniswapv4.Options)
					value, _ = atomicV4Candidate(chainID, amount, tokenIn, tokenOut, options, *atomicWork.v4Pool, block, outputs[0])
				} else if quoteErr == nil && len(legs) == expectedLegs {
					pools := make([]common.Address, len(legs))
					for i, leg := range legs {
						pools[i] = common.HexToAddress(leg.Pool)
					}
					value, _ = atomicPlanCandidate(chainID, amount, tokenIn, tokenOut, deployment, item, block, outputs, pools)
				}
				results <- result{index: index, value: value}
				index, atomicWork, exists = takeWork()
				if !exists {
					return
				}
			}
		}()
	}
	go func() {
		workers.Wait()
		close(results)
	}()
	var ordered []result
	for item := range results {
		ordered = append(ordered, item)
	}
	if ctx.Err() != nil {
		return nil, connect.NewError(contextCode(ctx.Err()), ctx.Err())
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].index < ordered[j].index })
	quoteID := make([]byte, 32)
	if _, err := rand.Read(quoteID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("quote identity could not be generated"))
	}
	response := &atomicv1.PlanQuoteResponse{QuoteId: quoteID, SearchComplete: proto.Bool(searchCtx.Err() == nil)}
	for _, item := range ordered {
		if item.value != nil {
			response.Candidates = append(response.Candidates, item.value)
		}
	}
	if h.Store != nil {
		h.Store.saveAtomicQuote(chainKey, response, time.Now())
	}
	return connect.NewResponse(response), nil
}
