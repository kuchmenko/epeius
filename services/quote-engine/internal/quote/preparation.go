package quote

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
)

// PreparationStrategy admits a selection before building its immutable terms.
// Build owns transaction fields and the checks needed to prove its execution.
type PreparationStrategy interface {
	Select(context.Context, storedQuote, *quotev1.PrepareExecutionRequest, *quotev1.RouteQuote) (executionSelection, string)
	Build(*quotev1.PrepareExecutionResponse) (executionPlan, string)
}

type executionSelection struct {
	route       *quotev1.RouteQuote
	allocations []*quotev1.QuotedAllocation
	output      *big.Int
}

type executionPlan struct {
	transaction *quotev1.UnsignedTransaction
	spender     string
	permission  *permissionPlan
	checks      SimulationChecks
	verify      func(context.Context, Reader, common.Hash) string
}

type permissionPlan struct {
	target, token, spender string
	amount                 *big.Int
	expiration             uint64
}

func (p *permissionPlan) clone() *permissionPlan {
	if p == nil {
		return nil
	}
	result := *p
	result.amount = new(big.Int).Set(p.amount)
	return &result
}

type BalanceProbe struct{ Token, Owner string }
type AllowanceProbe struct{ Token, Owner, Spender string }

// SimulationChecks describes actual balance and allowance obligations. The
// simulator neither discovers routes nor infers policy from transaction targets.
type SimulationChecks struct {
	Input, Output   BalanceProbe
	Preserve        []BalanceProbe
	ClearAllowances []AllowanceProbe
}

func (s SimulationChecks) clone() SimulationChecks {
	s.Preserve = append([]BalanceProbe(nil), s.Preserve...)
	s.ClearAllowances = append([]AllowanceProbe(nil), s.ClearAllowances...)
	return s
}
