package quote

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type validatedAtomicTerms struct {
	terms             *atomicv1.AcceptedPlanTerms
	program           *atomicv1.PlanProgram
	planID            common.Hash
	executorPlanHash  common.Hash
	transaction       *quotev1.UnsignedTransaction
	checks            SimulationChecks
	amount, minimum   *big.Int
	expires, deadline *big.Int
}

func hasUnknown(message protoreflect.Message) bool {
	if len(message.GetUnknown()) != 0 {
		return true
	}
	unknown := false
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		if field.Message() == nil {
			return true
		}
		if field.IsList() {
			list := value.List()
			for i := 0; i < list.Len(); i++ {
				if hasUnknown(list.Get(i).Message()) {
					unknown = true
					return false
				}
			}
		} else if hasUnknown(value.Message()) {
			unknown = true
		}
		return !unknown
	})
	return unknown
}

func atomicStatus(status atomicv1.PlanPreparationStatus, message string) *connect.Response[atomicv1.PreparePlanResponse] {
	return connect.NewResponse(&atomicv1.PreparePlanResponse{Status: &status, Message: proto.String(message)})
}

func (h Handler) PreparePlan(ctx context.Context, request *connect.Request[atomicv1.PreparePlanRequest]) (*connect.Response[atomicv1.PreparePlanResponse], error) {
	r := request.Msg
	if r == nil || hasUnknown(r.ProtoReflect()) || len(r.QuoteId) != 32 || len(r.CandidateId) != 32 || r.Terms == nil || len(r.PlanId) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid Atomic V1 preparation request"))
	}
	if h.Store == nil {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote unavailable; request a fresh quote"), nil
	}
	now := time.Now()
	saved, ok := h.Store.atomicQuote(r.QuoteId, now)
	if !ok || saved.approvalRequired {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote expired or unavailable; request a fresh quote"), nil
	}
	chain, ok := h.Chains[saved.chain]
	if !ok || !chain.Config.ExecutionEnabled {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "execution is disabled"), nil
	}
	var candidate *atomicv1.PlanCandidate
	for _, item := range saved.response.Candidates {
		if bytes.Equal(item.CandidateId, r.CandidateId) {
			candidate = item
			break
		}
	}
	if candidate == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("candidate does not belong to quote"))
	}
	candidateID, err := atomicCandidateHash(candidate.Program, candidate.QuoteBlock, candidate.BranchQuotes)
	if err != nil || !bytes.Equal(candidateID.Bytes(), candidate.CandidateId) || !proto.Equal(r.Terms.Program, candidate.Program) || !proto.Equal(r.Terms.QuoteBlock, candidate.QuoteBlock) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("candidate or accepted terms do not match stored quote"))
	}
	validated, err := validateAcceptedAtomicTerms(chain, r.Terms, r.PlanId, now)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid Atomic V1 accepted terms"))
	}
	return h.finishAtomicPreparation(ctx, chain, saved.chain, r.QuoteId, validated, nil, now)
}

func (h Handler) RecheckPlan(ctx context.Context, request *connect.Request[atomicv1.RecheckPlanRequest]) (*connect.Response[atomicv1.PreparePlanResponse], error) {
	r := request.Msg
	if r == nil || hasUnknown(r.ProtoReflect()) || len(r.PreparationId) != 32 || len(r.PlanId) != 32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid Atomic V1 recheck request"))
	}
	if h.Store == nil {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "preparation unavailable; request a fresh quote"), nil
	}
	now := time.Now()
	stored, ok := h.Store.atomicPreparation(r.PreparationId, now)
	if !ok || stored.response.GetPreparation() == nil || !bytes.Equal(stored.response.Preparation.PlanId, r.PlanId) {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "preparation expired or unavailable; request a fresh quote"), nil
	}
	chain, ok := h.Chains[stored.chain]
	if !ok || !chain.Config.ExecutionEnabled {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "execution is disabled"), nil
	}
	terms := stored.response.Preparation.Terms
	validated, err := validateAcceptedAtomicTerms(chain, terms, r.PlanId, now)
	if err != nil || !bytes.Equal(stored.executorPlanHash, validated.executorPlanHash.Bytes()) || !proto.Equal(stored.response.Preparation.Transaction, planTransaction(validated.transaction)) {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "preparation terms are no longer usable; request a fresh quote"), nil
	}
	validated.checks = stored.checks.clone()
	return h.finishAtomicPreparation(ctx, chain, stored.chain, nil, validated, stored.response.Preparation, now)
}

func validateAcceptedAtomicTerms(chain Chain, terms *atomicv1.AcceptedPlanTerms, requestedPlanID []byte, now time.Time) (validatedAtomicTerms, error) {
	if terms == nil || hasUnknown(terms.ProtoReflect()) || terms.Program == nil || terms.Executor == nil || terms.QuoteBlock == nil || terms.Program.FormatVersion == nil || terms.Program.GetFormatVersion() != 1 || terms.Executor.Version == nil || terms.Executor.GetVersion() != 2 || len(terms.Program.ChainId) != 32 || len(terms.Program.TokenIn) != 20 || len(terms.Program.TokenOut) != 20 || len(terms.Program.AmountIn) != 32 || len(terms.Executor.Address) != 20 || len(terms.Executor.RuntimeCodeHash) != 32 || len(terms.Signer) != 20 || len(terms.Recipient) != 20 || len(terms.BranchMinima) != 1 || len(terms.BranchMinima[0]) != 32 || len(terms.AmountOutMinimum) != 32 || len(terms.QuoteBlock.Number) != 32 || len(terms.QuoteBlock.Hash) != 32 || len(terms.ExpiresAtUnix) != 32 || len(terms.DeadlineUnix) != 32 || len(terms.Program.Branches) != 1 {
		return validatedAtomicTerms{}, errors.New("incomplete accepted terms")
	}
	executor := chain.Config.AtomicExecutor
	if executor == nil || common.BytesToAddress(terms.Executor.Address) != common.HexToAddress(executor.Address) || common.BytesToHash(terms.Executor.RuntimeCodeHash) != common.HexToHash(executor.RuntimeCodeHash) || common.BytesToAddress(terms.Signer) == (common.Address{}) || !bytes.Equal(terms.Signer, terms.Recipient) || new(big.Int).SetBytes(terms.Program.ChainId).String() != chain.ChainID {
		return validatedAtomicTerms{}, errors.New("executor or parties mismatch")
	}
	amount := new(big.Int).SetBytes(terms.Program.AmountIn)
	minimum := new(big.Int).SetBytes(terms.AmountOutMinimum)
	branchMinimum := new(big.Int).SetBytes(terms.BranchMinima[0])
	expires := new(big.Int).SetBytes(terms.ExpiresAtUnix)
	deadline := new(big.Int).SetBytes(terms.DeadlineUnix)
	branch := terms.Program.Branches[0]
	if amount.Sign() <= 0 || minimum.Sign() <= 0 || branchMinimum.Sign() <= 0 || minimum.Cmp(branchMinimum) != 0 || expires.Sign() <= 0 || !expires.IsInt64() || deadline.Sign() <= 0 || !deadline.IsInt64() || expires.Cmp(deadline) > 0 || new(big.Int).SetInt64(now.Unix()).Cmp(expires) >= 0 || new(big.Int).SetInt64(now.Unix()).Cmp(deadline) >= 0 || branch == nil || len(branch.AmountIn) != 32 || new(big.Int).SetBytes(branch.AmountIn).Cmp(amount) != 0 || len(branch.Operations) < 1 || len(branch.Operations) > 2 || common.BytesToAddress(terms.Program.TokenIn) == common.BytesToAddress(terms.Program.TokenOut) {
		return validatedAtomicTerms{}, errors.New("invalid amounts or lifetime")
	}
	current := common.BytesToAddress(terms.Program.TokenIn)
	seenPools := map[common.Address]bool{}
	seenKeys := map[string]bool{}
	executorOperations := make([]atomicV1Operation, len(branch.Operations))
	var deployment config.Deployment
	var providerKind uint8
	for i, operation := range branch.Operations {
		pool, poolOK := atomicPool(operation)
		kind := pool.kind
		deploymentID := executor.UniswapDeployment
		expectedKind := "uniswap-v3"
		if kind == 2 {
			deploymentID, expectedKind = executor.PancakeDeployment, "pancake-v3"
		} else if kind == 3 {
			deploymentID, expectedKind = executor.SlipstreamDeployment, "aerodrome-slipstream"
		} else if kind == 4 {
			deploymentID, expectedKind = executor.BalancerDeployment, "balancer-v2"
		}
		configured, ok := chain.Config.Deployments[deploymentID]
		if deploymentID == "" || !ok || configured.Kind != expectedKind || chain.DeploymentErrors[deploymentID] != "" || (providerKind != 0 && providerKind != kind) {
			return validatedAtomicTerms{}, errors.New("deployment unavailable")
		}
		deployment, providerKind = configured, kind
		invalidSelector := !poolOK || (kind != 4 && pool.selector == nil) || (kind == 3 && (pool.selector.Sign() <= 0 || pool.selector.Cmp(big.NewInt(1<<23-1)) > 0)) || (kind < 3 && (pool.selector.Sign() < 0 || pool.selector.Cmp(big.NewInt(1_000_000)) >= 0))
		invalidPool := len(pool.factory) != 20 || len(pool.router) != 20 || len(pool.pool) != 20 || common.BytesToAddress(pool.factory) != common.HexToAddress(deployment.Factory) || common.BytesToAddress(pool.router) != common.HexToAddress(deployment.Router) || common.BytesToAddress(pool.pool) == (common.Address{})
		if kind == 4 {
			options, optionsOK := deployment.ProviderConfig.(balancer.Options)
			member := false
			for _, value := range options.Pools {
				member = member || common.HexToHash(value) == common.BytesToHash(pool.poolID)
			}
			invalidPool = !optionsOK || len(branch.Operations) != 1 || len(pool.vault) != 20 || len(pool.poolID) != 32 || common.BytesToAddress(pool.vault) == (common.Address{}) || common.BytesToHash(pool.poolID) == (common.Hash{}) || common.BytesToAddress(pool.vault) != common.HexToAddress(options.Vault) || !member
		}
		if operation == nil || len(operation.TokenIn) != 20 || len(operation.TokenOut) != 20 || invalidSelector || invalidPool || common.BytesToAddress(operation.TokenIn) != current || common.BytesToAddress(operation.TokenIn) == common.BytesToAddress(operation.TokenOut) {
			return validatedAtomicTerms{}, errors.New("invalid operation")
		}
		fee, spacing := uint32(0), int32(0)
		if kind == 3 {
			spacing = int32(pool.selector.Int64())
		} else if kind < 3 {
			fee = uint32(pool.selector.Uint64())
		}
		key := atomicV1PoolKeyFromValues(kind, common.BytesToAddress(operation.TokenIn), common.BytesToAddress(operation.TokenOut), fee, spacing)
		address := common.BytesToAddress(pool.pool)
		if kind == 4 {
			key, address = string(pool.poolID), balancerPoolAddress(common.BytesToHash(pool.poolID))
		}
		if seenPools[address] || seenKeys[key] {
			return validatedAtomicTerms{}, errors.New("repeated pool")
		}
		seenPools[address], seenKeys[key] = true, true
		current = common.BytesToAddress(operation.TokenOut)
		executorOperations[i] = atomicV1Operation{Kind: kind, TokenOut: current, Fee: new(big.Int).SetUint64(uint64(fee)), TickSpacing: big.NewInt(int64(spacing)), PoolId: common.BytesToHash(pool.poolID)}
	}
	if current != common.BytesToAddress(terms.Program.TokenOut) {
		return validatedAtomicTerms{}, errors.New("broken continuity")
	}
	planID, err := atomicV1PlanID(terms)
	if err != nil || !bytes.Equal(planID.Bytes(), requestedPlanID) {
		return validatedAtomicTerms{}, errors.New("plan ID mismatch")
	}
	deadlineValue := new(big.Int).Set(deadline)
	executorPlan := atomicV1ExecutorPlan{
		TokenIn: common.BytesToAddress(terms.Program.TokenIn), TokenOut: common.BytesToAddress(terms.Program.TokenOut), AmountIn: amount, MinAmountOut: minimum, Deadline: deadlineValue,
		Branches: []atomicV1Branch{{AmountIn: new(big.Int).Set(amount), MinAmountOut: new(big.Int).Set(branchMinimum), Operations: executorOperations}},
	}
	executorAddress := common.BytesToAddress(terms.Executor.Address)
	signer := common.BytesToAddress(terms.Signer)
	executorPlanHash, err := atomicV1ExecutorPlanHash(chain.ChainID, executorAddress, signer, executorPlan)
	if err != nil {
		return validatedAtomicTerms{}, err
	}
	data, err := contractabi.ExecutorV2.Pack("execute", executorPlan)
	if err != nil {
		return validatedAtomicTerms{}, err
	}
	transaction := &quotev1.UnsignedTransaction{ChainId: chain.ChainID, From: signer.Hex(), To: executorAddress.Hex(), Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "1000000"}
	checks := SimulationChecks{Input: BalanceProbe{Token: executorPlan.TokenIn.Hex(), Owner: signer.Hex()}, Output: BalanceProbe{Token: executorPlan.TokenOut.Hex(), Owner: signer.Hex()}}
	seenTokens := map[common.Address]bool{}
	for _, operation := range branch.Operations {
		spender := common.HexToAddress(deployment.Router)
		if providerKind == 4 {
			options, _ := deployment.ProviderConfig.(balancer.Options)
			spender = common.HexToAddress(options.Vault)
		}
		for _, token := range []common.Address{common.BytesToAddress(operation.TokenIn), common.BytesToAddress(operation.TokenOut)} {
			if !seenTokens[token] {
				seenTokens[token] = true
				checks.Preserve = append(checks.Preserve, BalanceProbe{Token: token.Hex(), Owner: executorAddress.Hex()})
				if providerKind != 4 {
					checks.Preserve = append(checks.Preserve, BalanceProbe{Token: token.Hex(), Owner: spender.Hex()})
				}
			}
		}
		checks.ClearAllowances = append(checks.ClearAllowances, AllowanceProbe{Token: common.BytesToAddress(operation.TokenIn).Hex(), Owner: executorAddress.Hex(), Spender: spender.Hex()})
	}
	return validatedAtomicTerms{terms: proto.CloneOf(terms), program: proto.CloneOf(terms.Program), planID: planID, executorPlanHash: executorPlanHash, transaction: transaction, checks: checks, amount: amount, minimum: minimum, expires: expires, deadline: deadline}, nil
}

func (h Handler) finishAtomicPreparation(ctx context.Context, chain Chain, chainKey string, quoteID []byte, value validatedAtomicTerms, frozen *atomicv1.UnsignedPreparation, now time.Time) (*connect.Response[atomicv1.PreparePlanResponse], error) {
	reader, ok := chain.Client.(executionReader)
	simulator, simulationOK := h.Simulator.(atomicSimulator)
	if !ok || !simulationOK {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "execution checks unavailable"), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if frozen == nil {
		quoteSnapshot := rpc.Snapshot{BlockNumber: new(big.Int).SetBytes(value.terms.QuoteBlock.Number).String(), BlockHash: common.BytesToHash(value.terms.QuoteBlock.Hash).Hex()}
		if err := reader.Canonical(ctx, quoteSnapshot); err != nil {
			return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote block could not be confirmed; request a fresh quote"), nil
		}
	}
	snapshot, err := reader.Snapshot(ctx)
	if err != nil || snapshot.Timestamp == 0 || snapshot.ChainID != chain.ChainID || !common.IsHexHash(snapshot.BlockHash) {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "could not read execution block"), nil
	}
	blockNumber, parseOK := new(big.Int).SetString(snapshot.BlockNumber, 10)
	if !parseOK || blockNumber.Sign() <= 0 || blockNumber.BitLen() > 256 {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "simulation block identity is invalid"), nil
	}
	if new(big.Int).SetUint64(snapshot.Timestamp).Cmp(value.deadline) >= 0 || new(big.Int).SetInt64(time.Now().Unix()).Cmp(value.expires) >= 0 {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote or preparation expired; request a fresh quote"), nil
	}
	if err := verifyAtomicV1Program(ctx, reader, chain.Config, value.program, common.BytesToAddress(value.terms.Signer), common.HexToHash(snapshot.BlockHash)); err != nil {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "Atomic V1 executor verification failed"), nil
	}
	allowanceData, _ := erc20ABI.Pack("allowance", common.BytesToAddress(value.terms.Signer), common.BytesToAddress(value.terms.Executor.Address))
	allowanceBytes, err := reader.Call(ctx, common.BytesToAddress(value.program.TokenIn), allowanceData, common.HexToHash(snapshot.BlockHash))
	if err != nil {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "allowance check failed"), nil
	}
	allowanceValues, err := evm.Unpack(erc20ABI.Methods["allowance"], allowanceBytes)
	if err != nil {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "allowance check failed"), nil
	}
	if allowanceValues[0].(*big.Int).Cmp(value.amount) < 0 {
		if frozen != nil || !h.Store.markAtomicApproval(quoteID, time.Now()) {
			return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "approval state changed; request a fresh quote"), nil
		}
		data, _ := erc20ABI.Pack("approve", common.BytesToAddress(value.terms.Executor.Address), value.amount)
		status := atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_APPROVAL_REQUIRED
		approval := &atomicv1.Erc20Approval{
			Token: append([]byte(nil), value.program.TokenIn...), Spender: append([]byte(nil), value.terms.Executor.Address...), Amount: uint256Bytes(value.amount),
			Transaction: planTransaction(&quotev1.UnsignedTransaction{ChainId: chain.ChainID, From: common.BytesToAddress(value.terms.Signer).Hex(), To: common.BytesToAddress(value.program.TokenIn).Hex(), Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "100000"}),
		}
		if err := reader.Canonical(ctx, snapshot); err != nil || new(big.Int).SetInt64(time.Now().Unix()).Cmp(value.expires) >= 0 {
			return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "approval block could not be confirmed; request a fresh quote"), nil
		}
		return connect.NewResponse(&atomicv1.PreparePlanResponse{Status: &status, Approval: approval, Message: proto.String("Approve the exact input amount, then request a fresh quote.")}), nil
	}
	preparationID := make([]byte, 32)
	if frozen == nil {
		if _, err := rand.Read(preparationID); err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("preparation identity could not be generated"))
		}
		frozen = &atomicv1.UnsignedPreparation{PreparationId: preparationID, PlanId: value.planID.Bytes(), Terms: proto.CloneOf(value.terms), Transaction: planTransaction(value.transaction)}
	} else {
		preparationID = append([]byte(nil), frozen.PreparationId...)
	}
	fingerprint, err := atomicV1TransactionFingerprint(value.planID, value.transaction)
	if err != nil {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED, "transaction identity could not be computed"), nil
	}
	simulation, err := simulator.SimulateAtomic(ctx, proto.CloneOf(value.transaction), value.checks.clone(), snapshot, value.amount, value.minimum)
	if err != nil {
		return atomicSimulationFailure(value.planID.Bytes(), preparationID, fingerprint.Bytes(), snapshot, blockNumber, simulationMessage(err)), nil
	}
	measured, err := validateAtomicSimulationLogs(simulation.Logs, common.BytesToAddress(value.terms.Executor.Address), common.BytesToAddress(value.terms.Signer), value.executorPlanHash, value.program, value.minimum)
	if err != nil || simulation.Output != measured.BranchOutput.String() {
		return atomicSimulationFailure(value.planID.Bytes(), preparationID, fingerprint.Bytes(), snapshot, blockNumber, errSimulationEvidence.Error()), nil
	}
	if err := reader.Canonical(ctx, snapshot); err != nil {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "simulation block could not be confirmed; request a fresh quote"), nil
	}
	if new(big.Int).SetInt64(time.Now().Unix()).Cmp(value.expires) >= 0 {
		return atomicStatus(atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote or preparation expired; request a fresh quote"), nil
	}
	outputs := make([][]byte, len(measured.OperationOutputs))
	for i, output := range measured.OperationOutputs {
		outputs[i] = uint256Bytes(output)
	}
	passed := atomicv1.SimulationStatus_SIMULATION_STATUS_PASSED
	ready := atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_READY
	response := &atomicv1.PreparePlanResponse{
		Status: &ready, Preparation: proto.CloneOf(frozen),
		Simulation: &atomicv1.SimulationEvidence{
			PlanId: value.planID.Bytes(), PreparationId: append([]byte(nil), preparationID...), TransactionFingerprint: fingerprint.Bytes(),
			Block:  &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(snapshot.BlockHash).Bytes()},
			Status: &passed, BranchResults: []*atomicv1.BranchQuote{{OperationOutputs: outputs}}, ObservedAtUnix: uint256Bytes(new(big.Int).SetInt64(time.Now().Unix())),
		},
	}
	if frozen != nil && len(quoteID) == 0 {
		return connect.NewResponse(response), nil
	}
	h.Store.saveAtomicPreparation(atomicPreparation{response: response, chain: chainKey, expires: time.Unix(value.expires.Int64(), 0), executorPlanHash: value.executorPlanHash.Bytes(), checks: value.checks}, now)
	return connect.NewResponse(response), nil
}

func atomicSimulationFailure(planID, preparationID, fingerprint []byte, snapshot rpc.Snapshot, blockNumber *big.Int, message string) *connect.Response[atomicv1.PreparePlanResponse] {
	rejected := atomicv1.PlanPreparationStatus_PLAN_PREPARATION_STATUS_REJECTED
	unavailable := atomicv1.SimulationStatus_SIMULATION_STATUS_UNAVAILABLE
	return connect.NewResponse(&atomicv1.PreparePlanResponse{
		Status: &rejected, Message: proto.String(message),
		Simulation: &atomicv1.SimulationEvidence{
			PlanId: append([]byte(nil), planID...), PreparationId: append([]byte(nil), preparationID...), TransactionFingerprint: append([]byte(nil), fingerprint...),
			Block:  &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(snapshot.BlockHash).Bytes()},
			Status: &unavailable, ObservedAtUnix: uint256Bytes(new(big.Int).SetInt64(time.Now().Unix())), Message: proto.String(message),
		},
	})
}

func planTransaction(transaction *quotev1.UnsignedTransaction) *atomicv1.PlanTransaction {
	chain, _ := new(big.Int).SetString(transaction.ChainId, 10)
	value, _ := new(big.Int).SetString(transaction.ValueAtomic, 10)
	gas, _ := new(big.Int).SetString(transaction.GasLimit, 10)
	data, _ := hexutil.Decode(transaction.Data)
	return &atomicv1.PlanTransaction{ChainId: uint256Bytes(chain), From: common.HexToAddress(transaction.From).Bytes(), To: common.HexToAddress(transaction.To).Bytes(), Data: data, Value: uint256Bytes(value), GasLimit: uint256Bytes(gas)}
}

func verifyAtomicV1Program(ctx context.Context, reader Reader, chain config.Chain, program *atomicv1.PlanProgram, signer common.Address, hash common.Hash) error {
	if program == nil || len(program.Branches) != 1 {
		return errors.New("invalid Atomic V1 program")
	}
	operations := program.Branches[0].Operations
	legs := make([]*quotev1.RouteLeg, len(operations))
	provider := ""
	for i, operation := range operations {
		pool, ok := atomicPool(operation)
		if !ok {
			return errors.New("invalid Atomic V1 operation")
		}
		operationProvider := "uniswap-v3"
		if pool.kind == 2 {
			operationProvider = "pancake-v3"
		} else if pool.kind == 3 {
			operationProvider = "aerodrome-slipstream"
		} else if pool.kind == 4 {
			operationProvider = "balancer-v2"
		}
		if provider != "" && provider != operationProvider {
			return errors.New("mixed Atomic V1 providers")
		}
		provider = operationProvider
		legs[i] = &quotev1.RouteLeg{TokenIn: common.BytesToAddress(operation.TokenIn).Hex(), TokenOut: common.BytesToAddress(operation.TokenOut).Hex(), Pool: common.BytesToAddress(pool.pool).Hex()}
		if pool.kind == 4 {
			legs[i].Pool = common.BytesToHash(pool.poolID).Hex()
			continue
		}
		if pool.kind == 3 {
			legs[i].Selector = &quotev1.RouteLeg_TickSpacing{TickSpacing: int32(pool.selector.Int64())}
		} else {
			legs[i].Selector = &quotev1.RouteLeg_FeePips{FeePips: uint32(pool.selector.Uint64())}
		}
	}
	if provider == "aerodrome-slipstream" {
		deployment := chain.Deployments[chain.AtomicExecutor.SlipstreamDeployment]
		if verifySlipstreamSignerDiscount(ctx, reader, hash, common.HexToAddress(deployment.Factory), signer.Hex()) != "" {
			return errors.New("Slipstream signer discount is not zero")
		}
	}
	return verifyAtomicV1Executor(ctx, reader, chain, &quotev1.RouteQuote{Provider: provider, Legs: legs}, hash)
}
