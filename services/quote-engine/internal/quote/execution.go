package quote

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

type Simulator interface {
	Simulate(context.Context, *quotev1.UnsignedTransaction, *quotev1.RouteQuote, rpc.Snapshot, *big.Int, *big.Int) (string, error)
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
	} else if r.QuoteId == "" || (r.RouteId == "") == (len(r.Allocations) == 0) || len(r.Allocations) > 2 || !address.MatchString(r.Sender) || common.HexToAddress(r.Sender) == (common.Address{}) || r.SlippageBps >= 10000 {
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
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote block is no longer canonical")
		}
		if len(r.Allocations) > 0 {
			allocations, err := quoteAllocations(ctx, chain, saved, r.Allocations)
			if err != nil {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "executor allocations could not be quoted")
			}
			output := new(big.Int)
			for _, allocation := range allocations {
				amount, _ := new(big.Int).SetString(allocation.Route.AmountOutAtomic, 10)
				output.Add(output, amount)
			}
			minimum := new(big.Int).Div(new(big.Int).Mul(output, big.NewInt(int64(10000-r.SlippageBps))), big.NewInt(10000))
			if minimum.Sign() == 0 || output.BitLen() > 256 {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "invalid aggregate output")
			}
			deadline := snapshot.Timestamp + 120
			sender := common.HexToAddress(r.Sender).Hex()
			response := &quotev1.PrepareExecutionResponse{PreparationId: rand.Text(), ExpiresAtUnix: strconv.FormatInt(now.Add(retention).Unix(), 10), AmountOutMinimumAtomic: minimum.String(), AmountInAtomic: saved.request.AmountInAtomic, TokenIn: saved.request.TokenIn, TokenOut: saved.request.TokenOut, Recipient: sender, DeadlineUnix: strconv.FormatUint(deadline, 10), Allocations: allocations}
			data, err := executorData(response, deadline)
			if err != nil {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "executor plan could not be encoded")
			}
			p = preparation{chain: key, expires: now.Add(retention), response: response, transaction: &quotev1.UnsignedTransaction{ChainId: chain.ChainID, To: common.HexToAddress(chain.Config.Executor.Address).Hex(), From: sender, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "3000000"}}
		} else {
			var route *quotev1.RouteQuote
			for _, candidate := range saved.final.Routes {
				if candidate.RouteId == r.RouteId {
					route = proto.Clone(candidate).(*quotev1.RouteQuote)
					break
				}
			}
			if route == nil {
				return invalid()
			}
			deployment, ok := chain.Config.Deployments[route.DeploymentId]
			if !ok {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "deployment unavailable")
			}
			amount, _ := new(big.Int).SetString(saved.request.AmountInAtomic, 10)
			output, _ := new(big.Int).SetString(route.AmountOutAtomic, 10)
			minimum := new(big.Int).Div(new(big.Int).Mul(output, big.NewInt(int64(10000-r.SlippageBps))), big.NewInt(10000))
			if minimum.Sign() == 0 {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "minimum output must be positive")
			}
			deadline := snapshot.Timestamp + 120
			sender := common.HexToAddress(r.Sender).Hex()
			data, err := swapData(deployment.Kind, route, sender, amount, minimum, deadline)
			if err != nil {
				return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "unsupported route")
			}
			p = preparation{chain: key, expires: now.Add(retention), transaction: &quotev1.UnsignedTransaction{ChainId: chain.ChainID, To: common.HexToAddress(deployment.Router).Hex(), From: sender, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "1500000"}, response: &quotev1.PrepareExecutionResponse{PreparationId: rand.Text(), ExpiresAtUnix: strconv.FormatInt(now.Add(retention).Unix(), 10), AmountOutMinimumAtomic: minimum.String(), AmountInAtomic: amount.String(), TokenIn: saved.request.TokenIn, TokenOut: saved.request.TokenOut, Recipient: sender, DeadlineUnix: strconv.FormatUint(deadline, 10), Route: route}}
		}
	}
	response := proto.Clone(p.response).(*quotev1.PrepareExecutionResponse)
	if len(response.Allocations) > 0 {
		if err := verifyExecutor(ctx, reader, chain.Config, common.HexToHash(snapshot.BlockHash)); err != nil {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "executor verification failed")
		}
	}
	deadline, _ := strconv.ParseUint(response.DeadlineUnix, 10, 64)
	if !time.Now().Before(p.expires) || snapshot.Timestamp >= deadline {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "preparation expired")
	}
	amount, _ := new(big.Int).SetString(response.AmountInAtomic, 10)
	minimum, _ := new(big.Int).SetString(response.AmountOutMinimumAtomic, 10)
	allowanceData, _ := erc20ABI.Pack("allowance", common.HexToAddress(response.Recipient), common.HexToAddress(p.transaction.To))
	allowanceBytes, err := reader.Call(ctx, common.HexToAddress(response.TokenIn), allowanceData, common.HexToHash(snapshot.BlockHash))
	if err != nil || len(allowanceBytes) != 32 {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "allowance check failed")
	}
	if !recheck {
		var exists bool
		p.approval, exists = h.Store.markApproval(r.QuoteId, response.Recipient+p.transaction.To, new(big.Int).SetBytes(allowanceBytes).Cmp(amount) < 0, time.Now())
		if !exists || !time.Now().Before(saved.expires) {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "quote expired during preparation")
		}
	}
	if new(big.Int).SetBytes(allowanceBytes).Cmp(amount) < 0 {
		if recheck && !p.approval {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "allowance changed; request a fresh quote")
		}
		data, _ := erc20ABI.Pack("approve", common.HexToAddress(p.transaction.To), amount)
		response.Status = quotev1.PreparationStatus_PREPARATION_STATUS_APPROVAL_REQUIRED
		response.Message = "approve the required amount, then request a fresh quote"
		response.ApprovalSpender = p.transaction.To
		response.ApprovalTransaction = &quotev1.UnsignedTransaction{ChainId: chain.ChainID, From: response.Recipient, To: response.TokenIn, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "100000"}
		if err := reader.Canonical(ctx, snapshot); err != nil || !time.Now().Before(p.expires) {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "approval check expired or block changed")
		}
		response.SimulationBlock = &quotev1.BlockContext{Number: snapshot.BlockNumber, Hash: snapshot.BlockHash}
		p.approval = true
		h.Store.savePreparation(p)
		return connect.NewResponse(response), nil
	}
	if p.approval {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "approval changed; request a fresh quote")
	}
	var output string
	if len(response.Allocations) > 0 {
		simulator, ok := h.Simulator.(interface {
			SimulateAllocations(context.Context, *quotev1.UnsignedTransaction, []*quotev1.QuotedAllocation, map[string]string, rpc.Snapshot, *big.Int, *big.Int) (string, error)
		})
		if !ok {
			return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "executor simulation unavailable")
		}
		routers := map[string]string{}
		for _, a := range response.Allocations {
			routers[a.Route.DeploymentId] = chain.Config.Deployments[a.Route.DeploymentId].Router
		}
		output, err = simulator.SimulateAllocations(ctx, p.transaction, response.Allocations, routers, snapshot, amount, minimum)
	} else {
		output, err = h.Simulator.Simulate(ctx, p.transaction, response.Route, snapshot, amount, minimum)
	}
	if err != nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REJECTED, "swap simulation could not prove safe execution")
	}
	if err := reader.Canonical(ctx, snapshot); err != nil {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "simulation block is no longer canonical")
	}
	if !time.Now().Before(p.expires) {
		return result(quotev1.PreparationStatus_PREPARATION_STATUS_REQUOTE_REQUIRED, "preparation expired during simulation")
	}
	response.Status = quotev1.PreparationStatus_PREPARATION_STATUS_READY
	response.Transaction = proto.Clone(p.transaction).(*quotev1.UnsignedTransaction)
	response.SimulationBlock = &quotev1.BlockContext{Number: snapshot.BlockNumber, Hash: snapshot.BlockHash}
	response.SimulatedAmountOutAtomic = output
	h.Store.savePreparation(p)
	return connect.NewResponse(response), nil
}

func mustABI(source string) abi.ABI {
	result, err := abi.JSON(strings.NewReader(source))
	if err != nil {
		panic(err)
	}
	return result
}

var erc20ABI = mustABI(`[{"name":"allowance","type":"function","inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"outputs":[{"type":"uint256"}]},{"name":"approve","type":"function","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},{"name":"balanceOf","type":"function","inputs":[{"name":"owner","type":"address"}],"outputs":[{"type":"uint256"}]}]`)
var uniRouterABI = mustABI(`[{"name":"exactInput","type":"function","inputs":[{"name":"params","type":"tuple","components":[{"name":"path","type":"bytes"},{"name":"recipient","type":"address"},{"name":"amountIn","type":"uint256"},{"name":"amountOutMinimum","type":"uint256"}]}],"outputs":[{"type":"uint256"}]},{"name":"multicall","type":"function","inputs":[{"name":"deadline","type":"uint256"},{"name":"data","type":"bytes[]"}],"outputs":[{"type":"bytes[]"}]}]`)

// Pancake v3-periphery ISwapRouter (not SmartRouter): the deadline is inside the tuple.
// https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-periphery/contracts/interfaces/ISwapRouter.sol
var pancakeRouterABI = mustABI(`[{"name":"exactInput","type":"function","inputs":[{"name":"params","type":"tuple","components":[{"name":"path","type":"bytes"},{"name":"recipient","type":"address"},{"name":"deadline","type":"uint256"},{"name":"amountIn","type":"uint256"},{"name":"amountOutMinimum","type":"uint256"}]}],"outputs":[{"type":"uint256"}]}]`)

func swapData(kind string, route *quotev1.RouteQuote, sender string, amount, minimum *big.Int, deadline uint64) ([]byte, error) {
	if len(route.Legs) < 1 || len(route.Legs) > 2 {
		return nil, errors.New("unsupported path")
	}
	var path []byte
	for i, leg := range route.Legs {
		fee, ok := leg.Selector.(*quotev1.RouteLeg_FeePips)
		if !ok || fee.FeePips >= 1000000 || !address.MatchString(leg.TokenIn) || !address.MatchString(leg.TokenOut) || i > 0 && !strings.EqualFold(route.Legs[i-1].TokenOut, leg.TokenIn) {
			return nil, errors.New("invalid path")
		}
		path = append(path, common.HexToAddress(leg.TokenIn).Bytes()...)
		path = append(path, byte(fee.FeePips>>16), byte(fee.FeePips>>8), byte(fee.FeePips))
	}
	path = append(path, common.HexToAddress(route.Legs[len(route.Legs)-1].TokenOut).Bytes()...)
	if kind == "pancake-v3" {
		return pancakeRouterABI.Pack("exactInput", struct {
			Path                                 []byte
			Recipient                            common.Address
			Deadline, AmountIn, AmountOutMinimum *big.Int
		}{path, common.HexToAddress(sender), new(big.Int).SetUint64(deadline), amount, minimum})
	}
	if kind != "uniswap-v3" {
		return nil, errors.New("unsupported router")
	}
	inner, err := uniRouterABI.Pack("exactInput", struct {
		Path                       []byte
		Recipient                  common.Address
		AmountIn, AmountOutMinimum *big.Int
	}{path, common.HexToAddress(sender), amount, minimum})
	if err != nil {
		return nil, err
	}
	return uniRouterABI.Pack("multicall", new(big.Int).SetUint64(deadline), [][]byte{inner})
}
