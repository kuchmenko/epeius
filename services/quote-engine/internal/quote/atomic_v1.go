package quote

import (
	"context"
	"errors"
	"math/big"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"google.golang.org/protobuf/proto"
)

type atomicV1Preparation struct{ chain Chain }

func (s atomicV1Preparation) Select(ctx context.Context, saved storedQuote, request *quotev1.PrepareExecutionRequest, route *quotev1.RouteQuote) (executionSelection, string) {
	if route == nil {
		if request != nil && len(request.Allocations) != 0 {
			return s.selectSplit(ctx, saved, request.Allocations)
		}
		return executionSelection{}, "Selected route is not supported by the configured Atomic V1 executor."
	}
	e := s.chain.Config.AtomicExecutor
	if e == nil || route.Provider != "uniswap-v3" || route.DeploymentId != e.UniswapDeployment || !validAtomicV1Route(route, saved.request.TokenIn, saved.request.TokenOut) {
		return executionSelection{}, "Selected route is not supported by the configured Atomic V1 executor."
	}
	output, ok := new(big.Int).SetString(route.AmountOutAtomic, 10)
	if !ok || output.Sign() <= 0 || output.BitLen() > 256 {
		return executionSelection{}, "invalid route output"
	}
	return executionSelection{route: proto.CloneOf(route), output: output}, ""
}

func (s atomicV1Preparation) selectSplit(ctx context.Context, saved storedQuote, requested []*quotev1.RouteAllocation) (executionSelection, string) {
	e := s.chain.Config.AtomicExecutor
	if e == nil || saved.request == nil || len(requested) != 2 {
		return executionSelection{}, "Selected routes are not supported by the configured Atomic V1 executor."
	}
	total := new(big.Int)
	seenPools := map[string]bool{}
	seenPoolKeys := map[string]bool{}
	allocations := make([]*quotev1.QuotedAllocation, 0, 2)
	for _, requestedAllocation := range requested {
		if requestedAllocation == nil || !positiveInteger.MatchString(requestedAllocation.AmountInAtomic) {
			return executionSelection{}, "Atomic V1 allocation inputs must be positive."
		}
		amount, ok := new(big.Int).SetString(requestedAllocation.AmountInAtomic, 10)
		if !ok || amount.BitLen() > 256 {
			return executionSelection{}, "Atomic V1 allocation inputs must be positive."
		}
		total.Add(total, amount)
		var route *quotev1.RouteQuote
		for _, candidate := range saved.final.Routes {
			if candidate.RouteId == requestedAllocation.RouteId {
				route = proto.CloneOf(candidate)
				break
			}
		}
		if route == nil || route.Provider != "uniswap-v3" || route.DeploymentId != e.UniswapDeployment || len(route.Legs) != 1 || !validAtomicV1Route(route, saved.request.TokenIn, saved.request.TokenOut) || !sameAtomicV1Block(route.Block, saved.final.Block) || s.chain.AllocationRequoters[route.DeploymentId] == nil || s.chain.DeploymentErrors[route.DeploymentId] != "" {
			return executionSelection{}, "Selected routes are not supported by the configured Atomic V1 executor."
		}
		pool := strings.ToLower(route.Legs[0].Pool)
		poolKey := atomicV1PoolKey(route.Legs[0])
		if seenPools[pool] || seenPoolKeys[poolKey] {
			return executionSelection{}, "Atomic V1 branches must use distinct pools."
		}
		seenPools[pool] = true
		seenPoolKeys[poolKey] = true
		allocations = append(allocations, &quotev1.QuotedAllocation{AmountInAtomic: amount.String(), Route: route})
	}
	if total.String() != saved.request.AmountInAtomic {
		return executionSelection{}, "Atomic V1 allocation inputs must sum to the quoted input amount."
	}
	output := new(big.Int)
	for _, allocation := range allocations {
		amount, _ := new(big.Int).SetString(allocation.AmountInAtomic, 10)
		quoted, err := s.chain.AllocationRequoters[allocation.Route.DeploymentId].Requote(ctx, allocation.Route, amount, saved.final.Block)
		if err != nil || !validAtomicV1Route(quoted, saved.request.TokenIn, saved.request.TokenOut) || len(quoted.Legs) != 1 || !sameAtomicV1Block(quoted.Block, saved.final.Block) || !strings.EqualFold(quoted.Legs[0].Pool, allocation.Route.Legs[0].Pool) || atomicV1PoolKey(quoted.Legs[0]) != atomicV1PoolKey(allocation.Route.Legs[0]) {
			return executionSelection{}, "Atomic V1 allocations could not be quoted."
		}
		allocation.Route = quoted
		quotedOutput, ok := new(big.Int).SetString(quoted.AmountOutAtomic, 10)
		if !ok || quotedOutput.Sign() <= 0 || quotedOutput.BitLen() > 256 {
			return executionSelection{}, "invalid aggregate output"
		}
		output.Add(output, quotedOutput)
	}
	if output.BitLen() > 256 {
		return executionSelection{}, "invalid aggregate output"
	}
	return executionSelection{allocations: allocations, output: output}, ""
}

func atomicV1PoolKey(leg *quotev1.RouteLeg) string {
	token0, token1 := strings.ToLower(leg.TokenIn), strings.ToLower(leg.TokenOut)
	if token0 > token1 {
		token0, token1 = token1, token0
	}
	return token0 + ":" + token1 + ":" + strconv.FormatUint(uint64(leg.GetFeePips()), 10)
}

func sameAtomicV1Block(a, b *quotev1.BlockContext) bool {
	return a != nil && b != nil && a.Number == b.Number && strings.EqualFold(a.Hash, b.Hash)
}

func validAtomicV1Route(route *quotev1.RouteQuote, tokenIn, tokenOut string) bool {
	if route == nil || len(route.Legs) < 1 || len(route.Legs) > 2 {
		return false
	}
	current := tokenIn
	pools := make(map[string]bool, len(route.Legs))
	poolKeys := make(map[string]bool, len(route.Legs))
	for _, leg := range route.Legs {
		if leg == nil {
			return false
		}
		fee, ok := leg.GetSelector().(*quotev1.RouteLeg_FeePips)
		pool := strings.ToLower(leg.GetPool())
		poolKey := atomicV1PoolKey(leg)
		if !ok || fee.FeePips >= 1000000 || !validAddress(pool) || pools[pool] || poolKeys[poolKey] || !validAddress(leg.TokenIn) || !validAddress(leg.TokenOut) || !strings.EqualFold(leg.TokenIn, current) || strings.EqualFold(leg.TokenIn, leg.TokenOut) {
			return false
		}
		pools[pool] = true
		poolKeys[poolKey] = true
		current = leg.TokenOut
	}
	return strings.EqualFold(current, tokenOut)
}

type atomicV1Operation struct {
	Kind        uint8
	TokenOut    common.Address
	Fee         *big.Int
	TickSpacing *big.Int
	PoolId      [32]byte
}

type atomicV1Branch struct {
	AmountIn     *big.Int
	MinAmountOut *big.Int
	Operations   []atomicV1Operation
}

type atomicV1ExecutorPlan struct {
	TokenIn      common.Address
	TokenOut     common.Address
	AmountIn     *big.Int
	MinAmountOut *big.Int
	Deadline     *big.Int
	Branches     []atomicV1Branch
}

type atomicV1PreparedBranch struct {
	amount, minimum *big.Int
	route           *quotev1.RouteQuote
}

func (s atomicV1Preparation) Build(p *quotev1.PrepareExecutionResponse, slippageBps uint32) (executionPlan, string) {
	if s.chain.Config.AtomicExecutor == nil {
		return executionPlan{}, "invalid Atomic V1 route"
	}
	amount, amountOK := new(big.Int).SetString(p.AmountInAtomic, 10)
	minimum, minimumOK := new(big.Int).SetString(p.AmountOutMinimumAtomic, 10)
	deadline, deadlineErr := strconv.ParseUint(p.DeadlineUnix, 10, 64)
	expiresAt, expiresErr := strconv.ParseUint(p.ExpiresAtUnix, 10, 64)
	if !amountOK || !minimumOK || amount.Sign() <= 0 || minimum.Sign() <= 0 || deadlineErr != nil || expiresErr != nil || slippageBps >= 10000 {
		return executionPlan{}, "invalid Atomic V1 amounts"
	}
	preparedBranches := make([]atomicV1PreparedBranch, 0, 2)
	if p.Route != nil && len(p.Allocations) == 0 && validAtomicV1Route(p.Route, p.TokenIn, p.TokenOut) {
		preparedBranches = append(preparedBranches, atomicV1PreparedBranch{amount: amount, minimum: minimum, route: p.Route})
	} else if p.Route == nil && len(p.Allocations) == 2 {
		total := new(big.Int)
		seenPools := map[string]bool{}
		seenPoolKeys := map[string]bool{}
		for _, allocation := range p.Allocations {
			if allocation == nil || allocation.Route == nil || len(allocation.Route.Legs) != 1 || !validAtomicV1Route(allocation.Route, p.TokenIn, p.TokenOut) {
				return executionPlan{}, "invalid Atomic V1 route"
			}
			allocationAmount, ok := new(big.Int).SetString(allocation.AmountInAtomic, 10)
			quotedOutput, outputOK := new(big.Int).SetString(allocation.Route.AmountOutAtomic, 10)
			if !ok || !outputOK || allocationAmount.Sign() <= 0 || allocationAmount.BitLen() > 256 || quotedOutput.Sign() <= 0 || quotedOutput.BitLen() > 256 {
				return executionPlan{}, "invalid Atomic V1 amounts"
			}
			pool := strings.ToLower(allocation.Route.Legs[0].Pool)
			poolKey := atomicV1PoolKey(allocation.Route.Legs[0])
			if seenPools[pool] || seenPoolKeys[poolKey] {
				return executionPlan{}, "invalid Atomic V1 route"
			}
			seenPools[pool] = true
			seenPoolKeys[poolKey] = true
			branchMinimum := new(big.Int).Div(new(big.Int).Mul(quotedOutput, big.NewInt(int64(10000-slippageBps))), big.NewInt(10000))
			if branchMinimum.Sign() <= 0 {
				return executionPlan{}, "invalid Atomic V1 amounts"
			}
			total.Add(total, allocationAmount)
			preparedBranches = append(preparedBranches, atomicV1PreparedBranch{amount: allocationAmount, minimum: branchMinimum, route: allocation.Route})
		}
		if total.Cmp(amount) != 0 {
			return executionPlan{}, "invalid Atomic V1 amounts"
		}
	} else {
		return executionPlan{}, "invalid Atomic V1 route"
	}
	block := preparedBranches[0].route.Block
	if block == nil {
		return executionPlan{}, "invalid Atomic V1 route"
	}
	for _, prepared := range preparedBranches[1:] {
		if !sameAtomicV1Block(prepared.route.Block, block) {
			return executionPlan{}, "invalid Atomic V1 route"
		}
	}
	quoteBlock, blockOK := new(big.Int).SetString(block.Number, 10)
	if !blockOK || quoteBlock.Sign() < 0 || quoteBlock.BitLen() > 256 || !common.IsHexHash(block.Hash) {
		return executionPlan{}, "invalid Atomic V1 amounts"
	}
	executorBranches := make([]atomicV1Branch, len(preparedBranches))
	wireBranches := make([]*atomicv1.Branch, len(preparedBranches))
	for i, prepared := range preparedBranches {
		operations := make([]atomicV1Operation, len(prepared.route.Legs))
		wireOperations := make([]*atomicv1.Operation, len(prepared.route.Legs))
		for j, leg := range prepared.route.Legs {
			operations[j] = atomicV1Operation{Kind: 1, TokenOut: common.HexToAddress(leg.TokenOut), Fee: new(big.Int).SetUint64(uint64(leg.GetFeePips())), TickSpacing: new(big.Int)}
			wireOperations[j] = &atomicv1.Operation{Kind: 1, TokenOut: leg.TokenOut, FeePips: leg.GetFeePips(), PoolId: (common.Hash{}).Hex()}
		}
		executorBranches[i] = atomicV1Branch{AmountIn: prepared.amount, MinAmountOut: prepared.minimum, Operations: operations}
		wireBranches[i] = &atomicv1.Branch{AmountInAtomic: prepared.amount.String(), AmountOutMinimumAtomic: prepared.minimum.String(), Operations: wireOperations}
	}
	executor := common.HexToAddress(s.chain.Config.AtomicExecutor.Address)
	sender := common.HexToAddress(p.Recipient)
	executorPlan := atomicV1ExecutorPlan{
		TokenIn: common.HexToAddress(p.TokenIn), TokenOut: common.HexToAddress(p.TokenOut),
		AmountIn: amount, MinAmountOut: minimum, Deadline: new(big.Int).SetUint64(deadline),
		Branches: executorBranches,
	}
	planHash, err := atomicV1ExecutorPlanHash(s.chain.ChainID, executor, sender, executorPlan)
	if err != nil {
		return executionPlan{}, "Atomic V1 executor plan could not be committed"
	}
	plan := &atomicv1.Plan{
		ExecutorPlanHash: planHash.Hex(), ChainId: s.chain.ChainID, Executor: executor.Hex(), Sender: sender.Hex(),
		TokenIn: p.TokenIn, TokenOut: p.TokenOut, AmountInAtomic: amount.String(), AmountOutMinimumAtomic: minimum.String(), DeadlineUnix: p.DeadlineUnix,
		Branches: wireBranches,
	}
	data, err := contractabi.ExecutorV2.Pack("execute", executorPlan)
	if err != nil {
		return executionPlan{}, "Atomic V1 plan could not be encoded"
	}
	tx := &quotev1.UnsignedTransaction{ChainId: s.chain.ChainID, To: executor.Hex(), From: sender.Hex(), Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "1000000"}
	deployment := s.chain.Config.Deployments[s.chain.Config.AtomicExecutor.UniswapDeployment]
	acceptedTerms, planID, err := atomicV1AcceptedTerms(
		s.chain.ChainID, executor, common.HexToHash(s.chain.Config.AtomicExecutor.RuntimeCodeHash), sender,
		common.HexToAddress(p.TokenIn), common.HexToAddress(p.TokenOut), amount, minimum,
		common.HexToAddress(deployment.Factory), common.HexToAddress(deployment.Router), preparedBranches,
		quoteBlock, common.HexToHash(block.Hash), expiresAt, deadline,
	)
	if err != nil {
		return executionPlan{}, "Atomic V1 accepted terms could not be committed"
	}
	fingerprint, err := atomicV1TransactionFingerprint(planID, tx)
	if err != nil {
		return executionPlan{}, "Atomic V1 transaction could not be committed"
	}
	plan.AcceptedTerms = acceptedTerms
	plan.PlanId = planID.Bytes()
	plan.TransactionFingerprint = fingerprint.Bytes()
	router := deployment.Router
	checks := SimulationChecks{Input: BalanceProbe{Token: p.TokenIn, Owner: sender.Hex()}, Output: BalanceProbe{Token: p.TokenOut, Owner: sender.Hex()}}
	seen := map[string]bool{}
	for _, prepared := range preparedBranches {
		for _, leg := range prepared.route.Legs {
			checks.ClearAllowances = append(checks.ClearAllowances, AllowanceProbe{Token: leg.TokenIn, Owner: executor.Hex(), Spender: router})
			for _, token := range []string{leg.TokenIn, leg.TokenOut} {
				key := strings.ToLower(token)
				if seen[key] {
					continue
				}
				seen[key] = true
				checks.Preserve = append(checks.Preserve, BalanceProbe{Token: token, Owner: executor.Hex()}, BalanceProbe{Token: token, Owner: router})
			}
		}
	}
	return executionPlan{transaction: tx, atomicPlan: plan, spender: executor.Hex(), checks: checks, verify: func(ctx context.Context, reader Reader, hash common.Hash) string {
		for _, prepared := range preparedBranches {
			if verifyAtomicV1Executor(ctx, reader, s.chain.Config, prepared.route, hash) != nil {
				return "Atomic V1 executor verification failed"
			}
		}
		return ""
	}}, ""
}

func atomicUint256Bytes(value *big.Int) []byte {
	return value.FillBytes(make([]byte, 32))
}

func atomicV1AcceptedTerms(chainID string, executor common.Address, runtimeHash common.Hash, signer, tokenIn, tokenOut common.Address, amountIn, minimum *big.Int, factory, router common.Address, branches []atomicV1PreparedBranch, quoteBlock *big.Int, quoteBlockHash common.Hash, expiresAt, deadline uint64) (*atomicv1.AcceptedPlanTerms, common.Hash, error) {
	chain, ok := new(big.Int).SetString(chainID, 10)
	if !ok || chain.Sign() < 0 || chain.BitLen() > 256 {
		return nil, common.Hash{}, errors.New("invalid chain ID")
	}
	acceptedBranches := make([]*atomicv1.PlanBranch, len(branches))
	branchMinima := make([][]byte, len(branches))
	for i, branch := range branches {
		acceptedOperations := make([]*atomicv1.PoolOperation, len(branch.route.Legs))
		for j, leg := range branch.route.Legs {
			acceptedOperations[j] = &atomicv1.PoolOperation{
				TokenIn: common.HexToAddress(leg.TokenIn).Bytes(), TokenOut: common.HexToAddress(leg.TokenOut).Bytes(), Pool: &atomicv1.PoolOperation_UniswapV3{UniswapV3: &atomicv1.V3Pool{
					Factory: factory.Bytes(), Router: router.Bytes(), Pool: common.HexToAddress(leg.Pool).Bytes(), FeePips: proto.Uint32(leg.GetFeePips()),
				}},
			}
		}
		acceptedBranches[i] = &atomicv1.PlanBranch{AmountIn: atomicUint256Bytes(branch.amount), Operations: acceptedOperations}
		branchMinima[i] = atomicUint256Bytes(branch.minimum)
	}
	terms := &atomicv1.AcceptedPlanTerms{
		Program: &atomicv1.PlanProgram{
			FormatVersion: proto.Uint32(1), ChainId: atomicUint256Bytes(chain), TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(), AmountIn: atomicUint256Bytes(amountIn),
			Branches: acceptedBranches,
		},
		Executor: &atomicv1.ExecutorIdentity{Address: executor.Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: runtimeHash.Bytes()},
		Signer:   signer.Bytes(), Recipient: signer.Bytes(), BranchMinima: branchMinima, AmountOutMinimum: atomicUint256Bytes(minimum),
		QuoteBlock: &atomicv1.PinnedBlock{Number: atomicUint256Bytes(quoteBlock), Hash: quoteBlockHash.Bytes()}, ExpiresAtUnix: atomicUint256Bytes(new(big.Int).SetUint64(expiresAt)), DeadlineUnix: atomicUint256Bytes(new(big.Int).SetUint64(deadline)),
	}
	planID, err := atomicV1PlanID(terms)
	if err != nil {
		return nil, common.Hash{}, err
	}
	return terms, planID, nil
}

func atomicV1PlanID(terms *atomicv1.AcceptedPlanTerms) (common.Hash, error) {
	if terms == nil || terms.Program == nil || terms.Executor == nil || terms.QuoteBlock == nil || len(terms.BranchMinima) != len(terms.Program.Branches) {
		return common.Hash{}, errors.New("incomplete accepted terms")
	}
	branchHashes := make([]common.Hash, len(terms.Program.Branches))
	for i, branch := range terms.Program.Branches {
		operationHashes := make([]common.Hash, len(branch.Operations))
		for j, operation := range branch.Operations {
			pool := operation.GetUniswapV3()
			if pool == nil {
				return common.Hash{}, errors.New("unsupported operation")
			}
			providerHash, err := atomicHash(
				abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint8")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("uint24")}},
				crypto.Keccak256Hash([]byte("Epeius.AtomicProvider.v1")), uint8(1), common.BytesToAddress(pool.Factory), common.BytesToAddress(pool.Router), common.BytesToAddress(pool.Pool), new(big.Int).SetUint64(uint64(pool.GetFeePips())),
			)
			if err != nil {
				return common.Hash{}, err
			}
			operationHashes[j], err = atomicHash(
				abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint8")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("bytes32")}},
				crypto.Keccak256Hash([]byte("Epeius.AtomicOperation.v1")), uint8(1), common.BytesToAddress(operation.TokenIn), common.BytesToAddress(operation.TokenOut), providerHash,
			)
			if err != nil {
				return common.Hash{}, err
			}
		}
		var err error
		branchHashes[i], err = atomicHash(
			abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("bytes32[]")}},
			crypto.Keccak256Hash([]byte("Epeius.AtomicAcceptedBranch.v1")), new(big.Int).SetBytes(branch.AmountIn), new(big.Int).SetBytes(terms.BranchMinima[i]), operationHashes,
		)
		if err != nil {
			return common.Hash{}, err
		}
	}
	return atomicHash(
		abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint32")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("address")}, {Type: atomicABIType("uint32")}, {Type: atomicABIType("bytes32")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("bytes32[]")}},
		crypto.Keccak256Hash([]byte("Epeius.AtomicPlan.v1")), terms.Program.GetFormatVersion(), new(big.Int).SetBytes(terms.Program.ChainId), common.BytesToAddress(terms.Executor.Address), terms.Executor.GetVersion(), common.BytesToHash(terms.Executor.RuntimeCodeHash), common.BytesToAddress(terms.Signer), common.BytesToAddress(terms.Recipient), common.BytesToAddress(terms.Program.TokenIn), common.BytesToAddress(terms.Program.TokenOut), new(big.Int).SetBytes(terms.Program.AmountIn), new(big.Int).SetBytes(terms.AmountOutMinimum), new(big.Int).SetBytes(terms.QuoteBlock.Number), common.BytesToHash(terms.QuoteBlock.Hash), new(big.Int).SetBytes(terms.ExpiresAtUnix), new(big.Int).SetBytes(terms.DeadlineUnix), branchHashes,
	)
}

func atomicV1TransactionFingerprint(planID common.Hash, tx *quotev1.UnsignedTransaction) (common.Hash, error) {
	chain, chainOK := new(big.Int).SetString(tx.ChainId, 10)
	value, valueOK := new(big.Int).SetString(tx.ValueAtomic, 10)
	gas, gasOK := new(big.Int).SetString(tx.GasLimit, 10)
	data, err := hexutil.Decode(tx.Data)
	if !chainOK || !valueOK || !gasOK || err != nil {
		return common.Hash{}, errors.New("invalid transaction")
	}
	return atomicHash(
		abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint256")}},
		crypto.Keccak256Hash([]byte("Epeius.AtomicTransaction.v1")), planID, chain, common.HexToAddress(tx.From), common.HexToAddress(tx.To), value, crypto.Keccak256Hash(data), gas,
	)
}

func atomicABIType(name string) abi.Type {
	t, err := abi.NewType(name, "", nil)
	if err != nil {
		panic(err)
	}
	return t
}

func atomicHash(arguments abi.Arguments, values ...any) (common.Hash, error) {
	encoded, err := arguments.Pack(values...)
	if err != nil {
		return common.Hash{}, err
	}
	return crypto.Keccak256Hash(encoded), nil
}

func atomicV1ExecutorPlanHash(chainID string, executor, sender common.Address, plan atomicV1ExecutorPlan) (common.Hash, error) {
	chain, ok := new(big.Int).SetString(chainID, 10)
	if !ok {
		return common.Hash{}, errors.New("invalid chain ID")
	}
	uint256Type, addressType := atomicABIType("uint256"), atomicABIType("address")
	planType := contractabi.ExecutorV2.Methods["execute"].Inputs[0].Type
	return atomicHash(
		abi.Arguments{{Type: uint256Type}, {Type: uint256Type}, {Type: addressType}, {Type: addressType}, {Type: planType}},
		big.NewInt(2), chain, executor, sender, plan,
	)
}

func verifyAtomicV1Executor(ctx context.Context, reader Reader, chain config.Chain, route *quotev1.RouteQuote, hash common.Hash) error {
	code, ok := reader.(codeReader)
	if !ok || chain.AtomicExecutor == nil || route == nil || len(route.Legs) < 1 || len(route.Legs) > 2 {
		return errors.New("Atomic V1 executor unavailable")
	}
	e := chain.AtomicExecutor
	target := common.HexToAddress(e.Address)
	runtime, err := code.Code(ctx, target, hash)
	if err != nil || crypto.Keccak256Hash(runtime) != common.HexToHash(e.RuntimeCodeHash) {
		return errors.New("Atomic V1 executor code unavailable")
	}
	deployment := chain.Deployments[e.UniswapDeployment]
	for name, expected := range map[string]string{"uniswapRouter": deployment.Router} {
		method := contractabi.ExecutorV2.Methods[name]
		data, err := reader.Call(ctx, target, method.ID, hash)
		if err != nil {
			return errors.New("Atomic V1 executor linkage failed")
		}
		values, err := evm.Unpack(method, data)
		if err != nil || values[0].(common.Address) != common.HexToAddress(expected) {
			return errors.New("Atomic V1 executor linkage failed")
		}
	}
	version := contractabi.ExecutorV2.Methods["version"]
	data, err := reader.Call(ctx, target, version.ID, hash)
	if err != nil {
		return errors.New("Atomic V1 executor version failed")
	}
	values, err := evm.Unpack(version, data)
	if err != nil || values[0].(*big.Int).Cmp(big.NewInt(2)) != 0 {
		return errors.New("Atomic V1 executor version failed")
	}
	method := contractabi.UniswapV3Factory.Methods["getPool"]
	for _, leg := range route.Legs {
		data, _ = method.Inputs.Pack(common.HexToAddress(leg.TokenIn), common.HexToAddress(leg.TokenOut), new(big.Int).SetUint64(uint64(leg.GetFeePips())))
		result, err := reader.Call(ctx, common.HexToAddress(deployment.Factory), append(method.ID, data...), hash)
		if err != nil {
			return errors.New("Atomic V1 pool verification failed")
		}
		values, err = evm.Unpack(method, result)
		if err != nil || values[0].(common.Address) != common.HexToAddress(leg.Pool) {
			return errors.New("Atomic V1 pool verification failed")
		}
	}
	return nil
}
