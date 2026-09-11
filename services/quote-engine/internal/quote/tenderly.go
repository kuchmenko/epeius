package quote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

var (
	errSimulationNotConfigured    = errors.New("Simulation is not configured. Check the engine's Tenderly settings.")
	errSimulationUnavailable      = errors.New("Simulation service is unavailable; execution was not prepared.")
	errSimulationTimeout          = errors.New("Simulation timed out; execution was not prepared.")
	errSimulationEvidence         = errors.New("Simulation evidence is incomplete or does not match the requested call and block.")
	errSimulationInputAmount      = errors.New("Simulation did not consume the exact input amount.")
	errSimulationMinimumOutput    = errors.New("Simulation output is below the minimum.")
	errSimulationProtectedBalance = errors.New("Simulation changed a balance that must be preserved.")
	errSimulationAllowance        = errors.New("Simulation left an executor-to-router allowance uncleared.")
)

type Tenderly struct {
	key, account, project string
	client                *http.Client
}

func NewTenderly(getenv func(string) string) *Tenderly {
	return &Tenderly{key: getenv("TENDERLY_ACCESS_KEY"), account: getenv("TENDERLY_ACCOUNT_SLUG"), project: getenv("TENDERLY_PROJECT_SLUG"), client: &http.Client{Timeout: 18 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}}
}

type simulationCall struct {
	NetworkID        string `json:"network_id"`
	BlockNumber      uint64 `json:"block_number"`
	TransactionIndex int64  `json:"transaction_index"`
	From             string `json:"from"`
	To               string `json:"to"`
	Input            string `json:"input"`
	Value            string `json:"value"`
	Gas              uint64 `json:"gas"`
	SimulationType   string `json:"simulation_type"`
	Save             bool   `json:"save"`
	SaveIfFails      bool   `json:"save_if_fails"`
}

type simulationIdentity struct {
	NetworkID   string `json:"network_id"`
	BlockNumber uint64 `json:"block_number"`
	From        string `json:"from"`
	To          string `json:"to"`
	Input       string `json:"input"`
	Value       string `json:"value"`
	Status      bool   `json:"status"`
}
type simulationResult struct {
	Simulation struct {
		simulationIdentity
		TransactionIndex int64 `json:"transaction_index"`
		BlockHeader      struct {
			Number    string `json:"number"`
			Hash      string `json:"hash"`
			Timestamp string `json:"timestamp"`
		} `json:"block_header"`
	} `json:"simulation"`
	Transaction struct {
		simulationIdentity
		TransactionInfo struct {
			CallTrace struct {
				From   string `json:"from"`
				To     string `json:"to"`
				Input  string `json:"input"`
				Output string `json:"output"`
				Error  string `json:"error"`
			} `json:"call_trace"`
		} `json:"transaction_info"`
	} `json:"transaction"`
}

type balanceProbe struct{ token, owner string }

func (t *Tenderly) Simulate(ctx context.Context, tx *quotev1.UnsignedTransaction, route *quotev1.RouteQuote, snapshot rpc.Snapshot, amount, minimum *big.Int) (string, error) {
	if route == nil || len(route.Legs) < 1 || len(route.Legs) > 2 {
		return "", errors.New("invalid simulation route")
	}
	probes := []balanceProbe{{route.Legs[0].TokenIn, tx.From}, {route.Legs[len(route.Legs)-1].TokenOut, tx.From}}
	if len(route.Legs) == 2 {
		probes = append(probes, balanceProbe{route.Legs[0].TokenOut, tx.To})
	}
	return t.simulate(ctx, tx, probes, nil, snapshot, amount, minimum)
}

func (t *Tenderly) SimulateAllocations(ctx context.Context, tx *quotev1.UnsignedTransaction, allocations []*quotev1.QuotedAllocation, routers map[string]string, snapshot rpc.Snapshot, amount, minimum *big.Int) (string, error) {
	if len(allocations) < 1 || len(allocations) > 2 || allocations[0].GetRoute() == nil || len(allocations[0].Route.Legs) == 0 {
		return "", errors.New("invalid simulation allocations")
	}
	first := allocations[0].Route.Legs
	probes := []balanceProbe{{first[0].TokenIn, tx.From}, {first[len(first)-1].TokenOut, tx.From}}
	// For allowance probes, owner names the spender; the owner is tx.To.
	var allowances []balanceProbe
	add := func(token, owner string) {
		for _, existing := range probes {
			if strings.EqualFold(existing.token, token) && strings.EqualFold(existing.owner, owner) {
				return
			}
		}
		probes = append(probes, balanceProbe{token, owner})
	}
	for _, a := range allocations {
		if a.GetRoute() == nil || len(a.Route.Legs) < 1 || len(a.Route.Legs) > 2 || !address.MatchString(routers[a.Route.DeploymentId]) {
			return "", errors.New("invalid simulation allocation route")
		}
		for _, leg := range a.Route.Legs {
			allowances = append(allowances, balanceProbe{leg.TokenIn, routers[a.Route.DeploymentId]})
			for _, token := range []string{leg.TokenIn, leg.TokenOut} {
				// All executor balances and router balances must be preserved.
				// Wallet intermediates must not change either.
				for _, owner := range []string{tx.From, tx.To, routers[a.Route.DeploymentId]} {
					add(token, owner)
				}
			}
		}
	}
	return t.simulate(ctx, tx, probes, allowances, snapshot, amount, minimum)
}

func (t *Tenderly) simulate(ctx context.Context, tx *quotev1.UnsignedTransaction, balances, allowances []balanceProbe, snapshot rpc.Snapshot, amount, minimum *big.Int) (string, error) {
	fail := errors.New("simulation verification failed")
	slug := regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	if t.key == "" || !slug.MatchString(t.account) || !slug.MatchString(t.project) {
		return "", errSimulationNotConfigured
	}
	if !positiveInteger.MatchString(tx.ChainId) || tx.ChainId != snapshot.ChainID || tx.ValueAtomic != "0" {
		return "", fail
	}
	number, err := strconv.ParseUint(snapshot.BlockNumber, 10, 64)
	if err != nil {
		return "", fail
	}
	gas, err := strconv.ParseUint(tx.GasLimit, 10, 64)
	if err != nil || gas == 0 {
		return "", fail
	}
	// RPC block-hash reads use end-of-block state. Tenderly defaults to index 0
	// (before the block's transactions); -1 selects end-of-block state instead.
	// Verified against a last-transaction approval on Base Sepolia block 46634361.
	base := simulationCall{NetworkID: tx.ChainId, BlockNumber: number, TransactionIndex: -1, From: tx.From, Value: "0", Gas: gas, SimulationType: "full"}
	// Every state query uses the same sender and sequential full-state bundle.
	// No allowance/balance overrides, virtual approval, USD asset metadata, or logs.
	balance := func(token, owner string) simulationCall {
		data, _ := erc20ABI.Pack("balanceOf", common.HexToAddress(owner))
		call := base
		call.To = token
		call.Input = hexutil.Encode(data)
		return call
	}
	var probes []simulationCall
	for _, probe := range balances {
		probes = append(probes, balance(probe.token, probe.owner))
	}
	calls := append([]simulationCall(nil), probes...)
	swap := base
	swap.To = tx.To
	swap.Input = tx.Data
	calls = append(calls, swap)
	calls = append(calls, probes...)
	for _, probe := range allowances {
		data, _ := erc20ABI.Pack("allowance", common.HexToAddress(tx.To), common.HexToAddress(probe.owner))
		call := base
		call.To, call.Input = probe.token, hexutil.Encode(data)
		calls = append(calls, call)
	}
	payload, err := json.Marshal(struct {
		Simulations []simulationCall `json:"simulations"`
	}{calls})
	if err != nil {
		return "", fail
	}
	ctx, cancel := context.WithTimeout(ctx, 18*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.tenderly.co/api/v1/account/"+t.account+"/project/"+t.project+"/simulate-bundle", bytes.NewReader(payload))
	if err != nil {
		return "", fail
	}
	req.Header.Set("X-Access-Key", t.key)
	req.Header.Set("Content-Type", "application/json")
	response, err := t.client.Do(req)
	if err != nil {
		var networkError net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
			return "", errSimulationTimeout
		}
		return "", errSimulationUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errSimulationUnavailable
	}
	var body struct {
		Results []simulationResult `json:"simulation_results"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&body); err != nil {
		var networkError net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
			return "", errSimulationTimeout
		}
		return "", errSimulationEvidence
	}
	if len(body.Results) != len(calls) {
		return "", errSimulationEvidence
	}
	values := make([]*big.Int, len(calls))
	for i, item := range body.Results {
		expected := calls[i]
		identityOK := func(actual simulationIdentity) bool {
			return actual.Status && actual.NetworkID == expected.NetworkID && actual.BlockNumber == expected.BlockNumber && strings.EqualFold(actual.From, expected.From) && strings.EqualFold(actual.To, expected.To) && strings.EqualFold(actual.Input, expected.Input) && (actual.Value == "0" || actual.Value == "0x" || actual.Value == "0x0")
		}
		header := item.Simulation.BlockHeader
		n, e1 := hexutil.DecodeUint64(header.Number)
		timestamp, e2 := hexutil.DecodeUint64(header.Timestamp)
		trace := item.Transaction.TransactionInfo.CallTrace
		if item.Simulation.TransactionIndex != -1 || !identityOK(item.Simulation.simulationIdentity) || !identityOK(item.Transaction.simulationIdentity) || e1 != nil || n != number || e2 != nil || timestamp != snapshot.Timestamp || !strings.EqualFold(header.Hash, snapshot.BlockHash) || trace.Error != "" || !strings.EqualFold(trace.From, expected.From) || !strings.EqualFold(trace.To, expected.To) || !strings.EqualFold(trace.Input, expected.Input) {
			return "", errSimulationEvidence
		}
		if i != len(probes) {
			raw, err := hexutil.Decode(trace.Output)
			if err != nil || len(raw) != 32 {
				return "", errSimulationEvidence
			}
			values[i] = new(big.Int).SetBytes(raw)
		}
	}
	after := len(probes) + 1
	consumed := new(big.Int).Sub(values[0], values[after])
	output := new(big.Int).Sub(values[after+1], values[1])
	if consumed.Cmp(amount) != 0 {
		return "", errSimulationInputAmount
	}
	if output.Cmp(minimum) < 0 {
		return "", errSimulationMinimumOutput
	}
	for i := 2; i < len(probes); i++ {
		if values[after+i].Cmp(values[i]) != 0 {
			return "", errSimulationProtectedBalance
		}
	}
	for i := after + len(probes); i < len(values); i++ {
		if values[i].Sign() != 0 {
			return "", errSimulationAllowance
		}
	}
	return output.String(), nil
}
