package quote

import (
	"context"
	"math/big"
	"strconv"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
)

// v3RouterPreparation is configured with one version's encoder at composition.
// The router version, deployment identity and target are independent values.
type v3RouterPreparation struct {
	id, kind, target, chainID string
	encode                    func(*quotev1.RouteQuote, string, *big.Int, *big.Int, uint64) ([]byte, error)
}

func (s v3RouterPreparation) Select(_ context.Context, _ storedQuote, _ *quotev1.PrepareExecutionRequest, route *quotev1.RouteQuote) (executionSelection, string) {
	if route == nil || route.DeploymentId != s.id || route.Provider != s.kind {
		return executionSelection{}, "unsupported route"
	}
	output, _ := new(big.Int).SetString(route.AmountOutAtomic, 10)
	return executionSelection{route: route, output: output}, ""
}

func (s v3RouterPreparation) Build(p *quotev1.PrepareExecutionResponse) (executionPlan, string) {
	amount, _ := new(big.Int).SetString(p.AmountInAtomic, 10)
	minimum, _ := new(big.Int).SetString(p.AmountOutMinimumAtomic, 10)
	if minimum.Sign() == 0 {
		return executionPlan{}, "minimum output must be positive"
	}
	deadline, _ := strconv.ParseUint(p.DeadlineUnix, 10, 64)
	data, err := s.encode(p.Route, p.Recipient, amount, minimum, deadline)
	if err != nil {
		return executionPlan{}, "unsupported route"
	}
	tx := &quotev1.UnsignedTransaction{ChainId: s.chainID, To: common.HexToAddress(s.target).Hex(), From: p.Recipient, Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: "1500000"}
	return executionPlan{transaction: tx, spender: tx.To, checks: directChecks(p.Route, tx)}, ""
}

func directChecks(route *quotev1.RouteQuote, tx *quotev1.UnsignedTransaction) SimulationChecks {
	checks := SimulationChecks{Input: BalanceProbe{route.Legs[0].TokenIn, tx.From}, Output: BalanceProbe{route.Legs[len(route.Legs)-1].TokenOut, tx.From}}
	if len(route.Legs) == 2 {
		checks.Preserve = []BalanceProbe{{route.Legs[0].TokenOut, tx.To}}
	}
	return checks
}
