package quote

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

type Simulator interface {
	Simulate(context.Context, *quotev1.UnsignedTransaction, SimulationChecks, rpc.Snapshot, *big.Int, *big.Int) (string, error)
}

type executionReader interface {
	Reader
	Canonical(context.Context, rpc.Snapshot) error
}

func (h Handler) PrepareExecution(ctx context.Context, request *connect.Request[quotev1.PrepareExecutionRequest]) (*connect.Response[quotev1.PrepareExecutionResponse], error) {
	r := request.Msg
	invalid := func() (*connect.Response[quotev1.PrepareExecutionResponse], error) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid preparation request"))
	}
	result := func(status quotev1.PreparationStatus, message string) (*connect.Response[quotev1.PrepareExecutionResponse], error) {
		return connect.NewResponse(&quotev1.PrepareExecutionResponse{Status: status, Message: message}), nil
	}
	if r.PreparationId != "" {
		if r.QuoteId != "" || r.RouteId != "" || r.Sender != "" || r.SlippageBps != 0 || len(r.Allocations) != 0 {
			return invalid()
		}
	} else if r.QuoteId == "" || (r.RouteId == "") == (len(r.Allocations) == 0) || len(r.Allocations) > 2 || !validAddress(r.Sender) || common.HexToAddress(r.Sender) == (common.Address{}) || r.SlippageBps >= 10000 {
		return invalid()
	}
	if h.Store == nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote unavailable; request a fresh quote")
	}
	now := time.Now()
	saved, found, p, recheck := h.Store.lookup(r.QuoteId, r.PreparationId, now)
	if r.PreparationId != "" && !recheck || r.PreparationId == "" && !found {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote or preparation expired or unavailable")
	}
	key := p.chain
	if !recheck {
		key = saved.request.Chain
	}
	chain, ok := h.Chains[key]
	if !ok || !chain.Config.ExecutionEnabled {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "execution is disabled")
	}
	reader, ok := chain.Client.(executionReader)
	if !ok || h.Simulator == nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "execution checks unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	snapshot, err := reader.Snapshot(ctx)
	if err != nil || snapshot.Timestamp == 0 || snapshot.ChainID != chain.ChainID {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "could not read execution block")
	}
	if !recheck {
		if err := reader.Canonical(ctx, rpc.Snapshot{BlockNumber: saved.final.Block.Number, BlockHash: saved.final.Block.Hash}); err != nil {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "The quote block could not be confirmed; request a fresh quote.")
		}
		strategy := chain.AllocationPreparer
		var route *quotev1.RouteQuote
		if r.RouteId != "" {
			for _, candidate := range saved.final.Routes {
				if candidate.RouteId == r.RouteId {
					route = proto.CloneOf(candidate)
					break
				}
			}
			if route == nil {
				return invalid()
			}
			strategy = chain.Preparers[route.DeploymentId]
		}
		if strategy == nil {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "deployment unavailable")
		}
		var message string
		p, message = buildPreparation(ctx, strategy, saved, r, route, now, snapshot.Timestamp)
		if message != "" {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, message)
		}
	}
	response := proto.CloneOf(p.response)
	if p.verify != nil {
		if message := p.verify(ctx, reader, common.HexToHash(snapshot.BlockHash)); message != "" {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, message)
		}
	}
	deadline, _ := strconv.ParseUint(response.DeadlineUnix, 10, 64)
	if !time.Now().Before(p.expires) || snapshot.Timestamp >= deadline {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Quote or preparation expired; request a fresh quote.")
	}
	amount, _ := new(big.Int).SetString(response.AmountInAtomic, 10)
	minimum, _ := new(big.Int).SetString(response.AmountOutMinimumAtomic, 10)
	allowanceData, _ := erc20ABI.Pack("allowance", common.HexToAddress(response.Recipient), common.HexToAddress(p.spender))
	allowanceBytes, err := reader.Call(ctx, common.HexToAddress(response.TokenIn), allowanceData, common.HexToHash(snapshot.BlockHash))
	if err != nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "allowance check failed")
	}
	values, err := evm.Unpack(erc20ABI.Methods["allowance"], allowanceBytes)
	if err != nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "allowance check failed")
	}
	allowance := values[0].(*big.Int)
	if !recheck {
		var exists bool
		p.approval, exists = h.Store.markApproval(r.QuoteId, response.Recipient+p.spender, allowance.Cmp(amount) < 0, time.Now())
		if !exists || !time.Now().Before(saved.expires) {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote expired or unavailable during preparation; request a fresh quote")
		}
	}
	if allowance.Cmp(amount) < 0 {
		if recheck && !p.approval {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Approval state changed; request a fresh quote.")
		}
		data, _ := erc20ABI.Pack("approve", common.HexToAddress(p.spender), amount)
		response.Status = quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED
		response.Message = "Approve the required amount, then request a fresh quote."
		response.ApprovalSpender = p.spender
		response.ApprovalTransaction = &quotev1.UnsignedTransaction{ChainId: chain.ChainID, From: response.Recipient, To: response.TokenIn, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "100000"}
		if err := reader.Canonical(ctx, snapshot); err != nil {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "The approval check block could not be confirmed; request a fresh quote.")
		}
		if !time.Now().Before(p.expires) {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Quote or preparation expired; request a fresh quote.")
		}
		response.SimulationBlock = &quotev1.BlockContext{Number: snapshot.BlockNumber, Hash: snapshot.BlockHash}
		p.approval = true
		h.Store.savePreparation(p)
		return connect.NewResponse(response), nil
	}
	if p.permission != nil {
		permission := p.permission
		data, _ := contractabi.Permit2.Pack("allowance", common.HexToAddress(response.Recipient), common.HexToAddress(permission.token), common.HexToAddress(permission.spender))
		permissionBytes, err := reader.Call(ctx, common.HexToAddress(permission.target), data, common.HexToHash(snapshot.BlockHash))
		if err != nil {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "permission check failed")
		}
		values, err := evm.Unpack(contractabi.Permit2.Methods["allowance"], permissionBytes)
		if err != nil {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "permission check failed")
		}
		permissionAmount := values[0].(*big.Int)
		expiration := values[1].(*big.Int).Uint64()
		required := permissionAmount.Cmp(permission.amount) < 0 || expiration <= deadline
		if !recheck {
			previous, exists := h.Store.markApproval(r.QuoteId, response.Recipient+permission.target+permission.spender, required, time.Now())
			p.approval = p.approval || previous
			if !exists || !time.Now().Before(saved.expires) {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote expired or unavailable during preparation; request a fresh quote")
			}
		}
		if required {
			if !recheck && p.approval {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Approval state changed; request a fresh quote.")
			}
			if recheck && !p.approval {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Permission state changed; request a fresh quote.")
			}
			call, _ := contractabi.Permit2.Pack("approve", common.HexToAddress(permission.token), common.HexToAddress(permission.spender), permission.amount, new(big.Int).SetUint64(permission.expiration))
			response.Status = quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED
			response.Message = "Grant the required Permit2 permission, then request a fresh quote."
			response.OnChainPermission = &quotev1.OnChainPermission{
				Target: permission.target, Token: permission.token, Spender: permission.spender,
				AmountAtomic: permission.amount.String(), ExpirationUnix: strconv.FormatUint(permission.expiration, 10),
				Transaction: &quotev1.UnsignedTransaction{ChainId: chain.ChainID, From: response.Recipient, To: permission.target, Data: hexutil.Encode(call), ValueAtomic: "0", GasLimit: "100000"},
			}
			if err := reader.Canonical(ctx, snapshot); err != nil {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "The permission check block could not be confirmed; request a fresh quote.")
			}
			if !time.Now().Before(p.expires) {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Quote or preparation expired; request a fresh quote.")
			}
			response.SimulationBlock = &quotev1.BlockContext{Number: snapshot.BlockNumber, Hash: snapshot.BlockHash}
			p.approval = true
			h.Store.savePreparation(p)
			return connect.NewResponse(response), nil
		}
	}
	if p.approval {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Approval state changed; request a fresh quote.")
	}
	output, err := h.Simulator.Simulate(ctx, proto.CloneOf(p.transaction), p.checks.clone(), snapshot, amount, minimum)
	if err != nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, simulationMessage(err))
	}
	if err := reader.Canonical(ctx, snapshot); err != nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "The simulation block could not be confirmed; request a fresh quote.")
	}
	if !time.Now().Before(p.expires) {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "Quote or preparation expired; request a fresh quote.")
	}
	response.Status = quotev1.PreparationStatus_PREPARATION_STATUS_READY
	response.Transaction = proto.CloneOf(p.transaction)
	response.SimulationBlock = &quotev1.BlockContext{Number: snapshot.BlockNumber, Hash: snapshot.BlockHash}
	response.SimulatedAmountOutAtomic = output
	h.Store.savePreparation(p)
	return connect.NewResponse(response), nil
}

func simulationMessage(err error) string {
	for _, known := range []error{errSimulationNotConfigured, errSimulationUnavailable, errSimulationTimeout, errSimulationEvidence, errSimulationInputAmount, errSimulationMinimumOutput, errSimulationProtectedBalance, errSimulationAllowance} {
		if errors.Is(err, known) {
			// Return only the fixed sentinel text, never an upstream wrapper.
			return known.Error()
		}
	}
	return "swap simulation could not prove safe execution"
}

// buildPreparation freezes economic terms and calls the selected builder once.
func buildPreparation(ctx context.Context, strategy PreparationStrategy, saved storedQuote, r *quotev1.PrepareExecutionRequest, route *quotev1.RouteQuote, now time.Time, timestamp uint64) (preparation, string) {
	selection, message := strategy.Select(ctx, saved, r, route)
	if message != "" {
		return preparation{}, message
	}
	minimum := new(big.Int).Div(new(big.Int).Mul(selection.output, big.NewInt(int64(10000-r.SlippageBps))), big.NewInt(10000))
	deadline := timestamp + 120
	sender := common.HexToAddress(r.Sender).Hex()
	response := &quotev1.PrepareExecutionResponse{PreparationId: rand.Text(), ExpiresAtUnix: strconv.FormatInt(now.Add(retention).Unix(), 10), AmountOutMinimumAtomic: minimum.String(), AmountInAtomic: saved.request.AmountInAtomic, TokenIn: saved.request.TokenIn, TokenOut: saved.request.TokenOut, Recipient: sender, DeadlineUnix: strconv.FormatUint(deadline, 10), Route: selection.route, Allocations: selection.allocations}
	plan, message := strategy.Build(proto.CloneOf(response))
	if message != "" {
		return preparation{}, message
	}
	plan.transaction = proto.CloneOf(plan.transaction)
	plan.permission = plan.permission.clone()
	plan.checks = plan.checks.clone()
	return preparation{chain: saved.request.Chain, expires: now.Add(retention), response: response, executionPlan: plan}, ""
}
