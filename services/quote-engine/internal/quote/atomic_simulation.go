package quote

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
)

var (
	atomicOperationTopic = crypto.Keccak256Hash([]byte("OperationExecuted(bytes32,uint256,uint256,uint8,address,address,uint256,uint256)"))
	atomicBranchTopic    = crypto.Keccak256Hash([]byte("BranchExecuted(bytes32,uint256,uint256,uint256)"))
	atomicNativeTopic    = crypto.Keccak256Hash([]byte("NativeRefunded(bytes32,address,uint256)"))
	atomicPlanTopic      = crypto.Keccak256Hash([]byte("PlanExecuted(bytes32,address,address,address,uint256,uint256)"))
)

func validateAtomicSimulationLogs(logs []SimulationLog, executor, caller common.Address, planHash common.Hash, program *atomicv1.PlanProgram, minimum *big.Int) (AtomicSimulationResult, error) {
	if program == nil || len(program.Branches) != 1 || len(program.Branches[0].Operations) < 1 || len(program.Branches[0].Operations) > 2 {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	var actual []SimulationLog
	for _, log := range logs {
		if log.Address == executor {
			actual = append(actual, log)
		}
	}
	operations := program.Branches[0].Operations
	if len(actual) != len(operations)+2 && len(actual) != len(operations)+3 {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	hasSlipstream := false
	for _, operation := range operations {
		pool, ok := atomicPool(operation)
		hasSlipstream = hasSlipstream || (ok && pool.kind == 3)
	}
	if len(actual) == len(operations)+3 && !hasSlipstream {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	amountIn := new(big.Int).SetBytes(program.AmountIn)
	previous := new(big.Int).Set(amountIn)
	outputs := make([]*big.Int, len(operations))
	for i, operation := range operations {
		log := actual[i]
		if len(log.Topics) != 4 || log.Topics[0] != atomicOperationTopic || log.Topics[1] != planHash || log.Topics[2] != (common.Hash{}) || log.Topics[3] != common.BigToHash(big.NewInt(int64(i))) {
			return AtomicSimulationResult{}, errSimulationEvidence
		}
		values, err := contractabi.ExecutorV2.Events["OperationExecuted"].Inputs.NonIndexed().Unpack(log.Data)
		if err != nil || len(values) != 5 {
			return AtomicSimulationResult{}, errSimulationEvidence
		}
		kind, kindOK := values[0].(uint8)
		tokenIn, inOK := values[1].(common.Address)
		tokenOut, outOK := values[2].(common.Address)
		measuredIn, amountOK := values[3].(*big.Int)
		measuredOut, outputOK := values[4].(*big.Int)
		pool, ok := atomicPool(operation)
		expectedKind := pool.kind
		if !ok || !kindOK || !inOK || !outOK || !amountOK || !outputOK || kind != expectedKind || expectedKind == 0 || tokenIn != common.BytesToAddress(operation.TokenIn) || tokenOut != common.BytesToAddress(operation.TokenOut) || measuredIn.Cmp(previous) != 0 || measuredOut.Sign() <= 0 {
			return AtomicSimulationResult{}, errSimulationEvidence
		}
		outputs[i] = new(big.Int).Set(measuredOut)
		previous.Set(measuredOut)
	}
	branch := actual[len(operations)]
	if len(branch.Topics) != 3 || branch.Topics[0] != atomicBranchTopic || branch.Topics[1] != planHash || branch.Topics[2] != (common.Hash{}) {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	branchValues, err := contractabi.ExecutorV2.Events["BranchExecuted"].Inputs.NonIndexed().Unpack(branch.Data)
	if err != nil || len(branchValues) != 2 {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	branchInput, inputOK := branchValues[0].(*big.Int)
	branchOutput, outputOK := branchValues[1].(*big.Int)
	if !inputOK || !outputOK || branchInput.Cmp(amountIn) != 0 || branchOutput.Cmp(previous) != 0 || previous.Cmp(minimum) < 0 {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	planIndex := len(operations) + 1
	if len(actual) == len(operations)+3 {
		refund := actual[planIndex]
		if len(refund.Topics) != 3 || refund.Topics[0] != atomicNativeTopic || refund.Topics[1] != planHash || refund.Topics[2] != common.BytesToHash(common.LeftPadBytes(caller.Bytes(), 32)) {
			return AtomicSimulationResult{}, errSimulationEvidence
		}
		values, err := contractabi.ExecutorV2.Events["NativeRefunded"].Inputs.NonIndexed().Unpack(refund.Data)
		if err != nil || len(values) != 1 || values[0].(*big.Int).Sign() <= 0 {
			return AtomicSimulationResult{}, errSimulationEvidence
		}
		planIndex++
	}
	plan := actual[planIndex]
	if len(plan.Topics) != 4 || plan.Topics[0] != atomicPlanTopic || plan.Topics[1] != planHash || plan.Topics[2] != common.BytesToHash(common.LeftPadBytes(caller.Bytes(), 32)) || plan.Topics[3] != common.BytesToHash(common.LeftPadBytes(program.TokenOut, 32)) {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	planValues, err := contractabi.ExecutorV2.Events["PlanExecuted"].Inputs.NonIndexed().Unpack(plan.Data)
	if err != nil || len(planValues) != 3 {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	planTokenIn, tokenOK := planValues[0].(common.Address)
	planInput, inputOK := planValues[1].(*big.Int)
	planOutput, outputOK := planValues[2].(*big.Int)
	if !tokenOK || !inputOK || !outputOK || planTokenIn != common.BytesToAddress(program.TokenIn) || planInput.Cmp(amountIn) != 0 || planOutput.Cmp(previous) != 0 {
		return AtomicSimulationResult{}, errSimulationEvidence
	}
	return AtomicSimulationResult{OperationOutputs: outputs, BranchOutput: new(big.Int).Set(previous)}, nil
}
