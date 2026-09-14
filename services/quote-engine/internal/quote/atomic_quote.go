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
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
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

func uint256Bytes(value *big.Int) []byte {
	return common.LeftPadBytes(value.Bytes(), 32)
}

func atomicCandidateHash(program *atomicv1.PlanProgram, block *atomicv1.PinnedBlock, quotes []*atomicv1.BranchQuote) (common.Hash, error) {
	uint8Type, uint24Type := atomicABIType("uint8"), atomicABIType("uint24")
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
			pool, kind := atomicV3Pool(operation)
			if pool == nil {
				return common.Hash{}, errors.New("unsupported operation")
			}
			providerHash, err := atomicHash(
				abi.Arguments{{Type: bytes32Type}, {Type: uint8Type}, {Type: addressType}, {Type: addressType}, {Type: addressType}, {Type: uint24Type}},
				atomicCandidateProviderDomain, kind, common.BytesToAddress(pool.Factory), common.BytesToAddress(pool.Router), common.BytesToAddress(pool.Pool), new(big.Int).SetUint64(uint64(pool.GetFeePips())),
			)
			if err != nil {
				return common.Hash{}, err
			}
			operationHashes[j], err = atomicHash(
				abi.Arguments{{Type: bytes32Type}, {Type: uint8Type}, {Type: addressType}, {Type: addressType}, {Type: bytes32Type}},
				atomicCandidateOperationDomain, kind, common.BytesToAddress(operation.TokenIn), common.BytesToAddress(operation.TokenOut), providerHash,
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

func atomicPlanCandidate(chainID, amount *big.Int, tokenIn, tokenOut common.Address, deployment config.Deployment, item candidate, block *atomicv1.PinnedBlock, outputs []*big.Int, legsPools []common.Address) (*atomicv1.PlanCandidate, error) {
	operations := make([]*atomicv1.PoolOperation, len(item.fees))
	seenPools := map[common.Address]bool{}
	seenKeys := map[string]bool{}
	for i, fee := range item.fees {
		pool := legsPools[i]
		key := atomicV1PoolKeyFromValues(item.tokens[i], item.tokens[i+1], fee)
		if seenPools[pool] || seenKeys[key] {
			return nil, nil
		}
		seenPools[pool], seenKeys[key] = true, true
		operation := &atomicv1.PoolOperation{
			TokenIn: item.tokens[i].Bytes(), TokenOut: item.tokens[i+1].Bytes(),
		}
		poolValue := &atomicv1.V3Pool{Factory: common.HexToAddress(deployment.Factory).Bytes(), Router: common.HexToAddress(deployment.Router).Bytes(), Pool: pool.Bytes(), FeePips: proto.Uint32(fee)}
		if deployment.Kind == "pancake-v3" {
			operation.Pool = &atomicv1.PoolOperation_PancakeV3{PancakeV3: poolValue}
		} else {
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

func atomicV1PoolKeyFromValues(in, out common.Address, fee uint32) string {
	if string(in[:]) > string(out[:]) {
		in, out = out, in
	}
	return string(in[:]) + string(out[:]) + string(new(big.Int).SetUint64(uint64(fee)).Bytes())
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
	for id, kind := range map[string]string{executor.UniswapDeployment: "uniswap-v3", executor.PancakeDeployment: "pancake-v3"} {
		deployment, ok := chain.Config.Deployments[id]
		if id != "" && ok && deployment.Kind == kind && chain.DeploymentErrors[id] == "" {
			deployments[id] = deployment
		}
	}
	if len(deployments) == 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("Atomic V1 V3 deployments are unavailable"))
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
	iterator := newCandidates(config.Chain{Tokens: chain.Config.Tokens, Deployments: deployments}, tokenIn, tokenOut)
	type result struct {
		index int
		value *atomicv1.PlanCandidate
	}
	results := make(chan result)
	var workers sync.WaitGroup
	for range h.QuoteConcurrency {
		index, item, exists := iterator.next(searchCtx)
		if !exists {
			break
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				deployment := deployments[item.deployment]
				legs, outputs, quoteErr := quotePathOutputs(searchCtx, chain.Client, deployment, item.tokens, item.fees, amount, common.HexToHash(snapshot.BlockHash))
				var value *atomicv1.PlanCandidate
				if quoteErr == nil && len(legs) == len(item.fees) {
					pools := make([]common.Address, len(legs))
					for i, leg := range legs {
						pools[i] = common.HexToAddress(leg.Pool)
					}
					value, _ = atomicPlanCandidate(chainID, amount, tokenIn, tokenOut, deployment, item, block, outputs, pools)
				}
				results <- result{index: index, value: value}
				index, item, exists = iterator.next(searchCtx)
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
