package quote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
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

func (t *Tenderly) Simulate(ctx context.Context, tx *quotev1.UnsignedTransaction, route *quotev1.RouteQuote, snapshot rpc.Snapshot, amount, minimum *big.Int) (string, error) {
	fail := errors.New("simulation verification failed")
	slug := regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	if t.key == "" || !slug.MatchString(t.account) || !slug.MatchString(t.project) || tx.ChainId != "84532" || tx.ChainId != snapshot.ChainID || tx.ValueAtomic != "0" || len(route.Legs) < 1 || len(route.Legs) > 2 {
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
	probes := []simulationCall{balance(route.Legs[0].TokenIn, tx.From), balance(route.Legs[len(route.Legs)-1].TokenOut, tx.From)}
	if len(route.Legs) == 2 {
		probes = append(probes, balance(route.Legs[0].TokenOut, tx.To))
	}
	calls := append([]simulationCall(nil), probes...)
	swap := base
	swap.To = tx.To
	swap.Input = tx.Data
	calls = append(calls, swap)
	calls = append(calls, probes...)
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
		return "", fail
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fail
	}
	var body struct {
		Results []simulationResult `json:"simulation_results"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&body); err != nil || len(body.Results) != len(calls) {
		return "", fail
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
			return "", fail
		}
		if i != len(probes) {
			raw, err := hexutil.Decode(trace.Output)
			if err != nil || len(raw) != 32 {
				return "", fail
			}
			values[i] = new(big.Int).SetBytes(raw)
		}
	}
	after := len(probes) + 1
	consumed := new(big.Int).Sub(values[0], values[after])
	output := new(big.Int).Sub(values[after+1], values[1])
	if consumed.Cmp(amount) != 0 || output.Cmp(minimum) < 0 || len(probes) == 3 && values[after+2].Cmp(values[2]) != 0 {
		return "", fail
	}
	return output.String(), nil
}
