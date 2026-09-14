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

func (s atomicV1Preparation) Select(_ context.Context, saved storedQuote, _ *quotev1.PrepareExecutionRequest, route *quotev1.RouteQuote) (executionSelection, string) {
	e := s.chain.Config.AtomicExecutor
	if e == nil || route == nil || route.Provider != "uniswap-v3" || route.DeploymentId != e.UniswapDeployment || len(route.Legs) != 1 {
		return executionSelection{}, "Selected route is not supported by the configured Atomic V1 executor."
	}
	leg := route.Legs[0]
	if leg == nil {
		return executionSelection{}, "Selected route is not supported by the configured Atomic V1 executor."
	}
	fee, ok := leg.Selector.(*quotev1.RouteLeg_FeePips)
	if !ok || fee.FeePips >= 1000000 || !validAddress(leg.Pool) || !validAddress(leg.TokenIn) || !validAddress(leg.TokenOut) || !strings.EqualFold(leg.TokenIn, saved.request.TokenIn) || !strings.EqualFold(leg.TokenOut, saved.request.TokenOut) {
		return executionSelection{}, "Selected route is not supported by the configured Atomic V1 executor."
	}
	output, ok := new(big.Int).SetString(route.AmountOutAtomic, 10)
	if !ok || output.Sign() <= 0 || output.BitLen() > 256 {
		return executionSelection{}, "invalid route output"
	}
	return executionSelection{route: proto.CloneOf(route), output: output}, ""
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

func (s atomicV1Preparation) Build(p *quotev1.PrepareExecutionResponse) (executionPlan, string) {
	if p.Route == nil || p.Route.Block == nil || len(p.Route.Legs) != 1 || s.chain.Config.AtomicExecutor == nil {
		return executionPlan{}, "invalid Atomic V1 route"
	}
	leg := p.Route.Legs[0]
	amount, amountOK := new(big.Int).SetString(p.AmountInAtomic, 10)
	minimum, minimumOK := new(big.Int).SetString(p.AmountOutMinimumAtomic, 10)
	deadline, deadlineErr := strconv.ParseUint(p.DeadlineUnix, 10, 64)
	expiresAt, expiresErr := strconv.ParseUint(p.ExpiresAtUnix, 10, 64)
	quoteBlock, blockOK := new(big.Int).SetString(p.Route.Block.Number, 10)
	if !amountOK || !minimumOK || !blockOK || amount.Sign() <= 0 || minimum.Sign() <= 0 || quoteBlock.Sign() < 0 || quoteBlock.BitLen() > 256 || deadlineErr != nil || expiresErr != nil || !common.IsHexHash(p.Route.Block.Hash) {
		return executionPlan{}, "invalid Atomic V1 amounts"
	}
	branch := atomicV1Branch{
		AmountIn: amount, MinAmountOut: minimum,
		Operations: []atomicV1Operation{{
			Kind: 1, TokenOut: common.HexToAddress(leg.TokenOut),
			Fee: new(big.Int).SetUint64(uint64(leg.GetFeePips())), TickSpacing: new(big.Int),
		}},
	}
	executor := common.HexToAddress(s.chain.Config.AtomicExecutor.Address)
	sender := common.HexToAddress(p.Recipient)
	executorPlan := atomicV1ExecutorPlan{
		TokenIn: common.HexToAddress(leg.TokenIn), TokenOut: common.HexToAddress(leg.TokenOut),
		AmountIn: amount, MinAmountOut: minimum, Deadline: new(big.Int).SetUint64(deadline),
		Branches: []atomicV1Branch{branch},
	}
	planHash, err := atomicV1ExecutorPlanHash(s.chain.ChainID, executor, sender, executorPlan)
	if err != nil {
		return executionPlan{}, "Atomic V1 executor plan could not be committed"
	}
	plan := &atomicv1.Plan{
		ExecutorPlanHash: planHash.Hex(), ChainId: s.chain.ChainID, Executor: executor.Hex(), Sender: sender.Hex(),
		TokenIn: leg.TokenIn, TokenOut: leg.TokenOut, AmountInAtomic: amount.String(), AmountOutMinimumAtomic: minimum.String(), DeadlineUnix: p.DeadlineUnix,
		Branches: []*atomicv1.Branch{{
			AmountInAtomic: amount.String(), AmountOutMinimumAtomic: minimum.String(),
			Operations: []*atomicv1.Operation{{
				Kind: 1, TokenOut: leg.TokenOut, FeePips: leg.GetFeePips(), PoolId: (common.Hash{}).Hex(),
			}},
		}},
	}
	data, err := contractabi.ExecutorV2.Pack("execute", executorPlan)
	if err != nil {
		return executionPlan{}, "Atomic V1 plan could not be encoded"
	}
	tx := &quotev1.UnsignedTransaction{ChainId: s.chain.ChainID, To: executor.Hex(), From: sender.Hex(), Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "1000000"}
	deployment := s.chain.Config.Deployments[s.chain.Config.AtomicExecutor.UniswapDeployment]
	acceptedTerms, planID, err := atomicV1AcceptedTerms(
		s.chain.ChainID, executor, common.HexToHash(s.chain.Config.AtomicExecutor.RuntimeCodeHash), sender,
		common.HexToAddress(leg.TokenIn), common.HexToAddress(leg.TokenOut), amount, minimum,
		common.HexToAddress(deployment.Factory), common.HexToAddress(deployment.Router), common.HexToAddress(leg.Pool), leg.GetFeePips(),
		quoteBlock, common.HexToHash(p.Route.Block.Hash), expiresAt, deadline,
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
	checks := SimulationChecks{
		Input: BalanceProbe{Token: leg.TokenIn, Owner: sender.Hex()}, Output: BalanceProbe{Token: leg.TokenOut, Owner: sender.Hex()},
		Preserve:        []BalanceProbe{{Token: leg.TokenIn, Owner: executor.Hex()}, {Token: leg.TokenOut, Owner: executor.Hex()}, {Token: leg.TokenIn, Owner: router}, {Token: leg.TokenOut, Owner: router}},
		ClearAllowances: []AllowanceProbe{{Token: leg.TokenIn, Owner: executor.Hex(), Spender: router}},
	}
	return executionPlan{transaction: tx, atomicPlan: plan, spender: executor.Hex(), checks: checks, verify: func(ctx context.Context, reader Reader, hash common.Hash) string {
		if verifyAtomicV1Executor(ctx, reader, s.chain.Config, p.Route, hash) != nil {
			return "Atomic V1 executor verification failed"
		}
		return ""
	}}, ""
}

func atomicUint256Bytes(value *big.Int) []byte {
	return value.FillBytes(make([]byte, 32))
}

func atomicV1AcceptedTerms(chainID string, executor common.Address, runtimeHash common.Hash, signer, tokenIn, tokenOut common.Address, amountIn, minimum *big.Int, factory, router, pool common.Address, fee uint32, quoteBlock *big.Int, quoteBlockHash common.Hash, expiresAt, deadline uint64) (*atomicv1.AcceptedPlanTerms, common.Hash, error) {
	chain, ok := new(big.Int).SetString(chainID, 10)
	if !ok || chain.Sign() < 0 || chain.BitLen() > 256 {
		return nil, common.Hash{}, errors.New("invalid chain ID")
	}
	providerHash, err := atomicHash(
		abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint8")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("uint24")}},
		crypto.Keccak256Hash([]byte("Epeius.AtomicProvider.v1")), uint8(1), factory, router, pool, new(big.Int).SetUint64(uint64(fee)),
	)
	if err != nil {
		return nil, common.Hash{}, err
	}
	operationHash, err := atomicHash(
		abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint8")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("bytes32")}},
		crypto.Keccak256Hash([]byte("Epeius.AtomicOperation.v1")), uint8(1), tokenIn, tokenOut, providerHash,
	)
	if err != nil {
		return nil, common.Hash{}, err
	}
	branchHash, err := atomicHash(
		abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("bytes32[]")}},
		crypto.Keccak256Hash([]byte("Epeius.AtomicAcceptedBranch.v1")), amountIn, minimum, []common.Hash{operationHash},
	)
	if err != nil {
		return nil, common.Hash{}, err
	}
	planID, err := atomicHash(
		abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint32")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("address")}, {Type: atomicABIType("uint32")}, {Type: atomicABIType("bytes32")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("uint256")}, {Type: atomicABIType("bytes32[]")}},
		crypto.Keccak256Hash([]byte("Epeius.AtomicPlan.v1")), uint32(1), chain, executor, uint32(2), runtimeHash, signer, signer, tokenIn, tokenOut, amountIn, minimum, quoteBlock, quoteBlockHash, new(big.Int).SetUint64(expiresAt), new(big.Int).SetUint64(deadline), []common.Hash{branchHash},
	)
	if err != nil {
		return nil, common.Hash{}, err
	}
	terms := &atomicv1.AcceptedPlanTerms{
		Program: &atomicv1.PlanProgram{
			FormatVersion: proto.Uint32(1), ChainId: atomicUint256Bytes(chain), TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(), AmountIn: atomicUint256Bytes(amountIn),
			Branches: []*atomicv1.PlanBranch{{AmountIn: atomicUint256Bytes(amountIn), Operations: []*atomicv1.PoolOperation{{
				TokenIn: tokenIn.Bytes(), TokenOut: tokenOut.Bytes(), Pool: &atomicv1.PoolOperation_UniswapV3{UniswapV3: &atomicv1.V3Pool{
					Factory: factory.Bytes(), Router: router.Bytes(), Pool: pool.Bytes(), FeePips: proto.Uint32(fee),
				}},
			}}}},
		},
		Executor: &atomicv1.ExecutorIdentity{Address: executor.Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: runtimeHash.Bytes()},
		Signer:   signer.Bytes(), Recipient: signer.Bytes(), BranchMinima: [][]byte{atomicUint256Bytes(minimum)}, AmountOutMinimum: atomicUint256Bytes(minimum),
		QuoteBlock: &atomicv1.PinnedBlock{Number: atomicUint256Bytes(quoteBlock), Hash: quoteBlockHash.Bytes()}, ExpiresAtUnix: atomicUint256Bytes(new(big.Int).SetUint64(expiresAt)), DeadlineUnix: atomicUint256Bytes(new(big.Int).SetUint64(deadline)),
	}
	return terms, planID, nil
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
	if !ok || chain.AtomicExecutor == nil || route == nil || len(route.Legs) != 1 {
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
	leg := route.Legs[0]
	data, _ = method.Inputs.Pack(common.HexToAddress(leg.TokenIn), common.HexToAddress(leg.TokenOut), new(big.Int).SetUint64(uint64(leg.GetFeePips())))
	result, err := reader.Call(ctx, common.HexToAddress(deployment.Factory), append(method.ID, data...), hash)
	if err != nil {
		return errors.New("Atomic V1 pool verification failed")
	}
	values, err = evm.Unpack(method, result)
	if err != nil || values[0].(common.Address) != common.HexToAddress(leg.Pool) {
		return errors.New("Atomic V1 pool verification failed")
	}
	return nil
}
