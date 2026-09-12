package quote

import (
	"context"
	"errors"
	"math/big"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	rpccontext "github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

var transferTopic = common.HexToHash("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")

// AnvilSimulator is an explicit local-fork test adapter. It only traces a
// call; it never signs, submits, impersonates, or changes fork state.
type AnvilSimulator struct {
	client  *gethrpc.Client
	chainID string
}

type anvilTrace struct {
	From  common.Address `json:"from"`
	To    common.Address `json:"to"`
	Input hexutil.Bytes  `json:"input"`
	Error string         `json:"error"`
	Logs  []struct {
		Address common.Address `json:"address"`
		Topics  []common.Hash  `json:"topics"`
		Data    hexutil.Bytes  `json:"data"`
	} `json:"logs"`
	Calls []anvilTrace `json:"calls"`
}

func NewAnvilSimulator(ctx context.Context, endpoint, chainID string) (*AnvilSimulator, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Anvil simulation requires a plain loopback HTTP RPC URL")
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, errors.New("Anvil simulation requires a plain loopback HTTP RPC URL")
	}
	client, err := gethrpc.DialContext(ctx, endpoint)
	if err != nil {
		return nil, errors.New("could not connect to Anvil simulation RPC")
	}
	var version string
	var actual hexutil.Uint64
	if err := client.CallContext(ctx, &version, "web3_clientVersion"); err != nil || !strings.HasPrefix(strings.ToLower(version), "anvil/") {
		client.Close()
		return nil, errors.New("local simulation RPC is not Anvil")
	}
	if err := client.CallContext(ctx, &actual, "eth_chainId"); err != nil || strconv.FormatUint(uint64(actual), 10) != chainID {
		client.Close()
		return nil, errors.New("Anvil simulation chain ID does not match configured chain")
	}
	return &AnvilSimulator{client: client, chainID: chainID}, nil
}

func (s *AnvilSimulator) Close() { s.client.Close() }

func (s *AnvilSimulator) Simulate(ctx context.Context, tx *quotev1.UnsignedTransaction, checks SimulationChecks, snapshot rpccontext.Snapshot, amount, minimum *big.Int) (string, error) {
	if tx.ChainId != s.chainID || tx.ChainId != snapshot.ChainID || tx.ValueAtomic != "0" || !validAddress(tx.From) || !validAddress(tx.To) || len(checks.ClearAllowances) != 0 {
		return "", errSimulationEvidence
	}
	gas, err := strconv.ParseUint(tx.GasLimit, 10, 64)
	if err != nil || gas == 0 || !common.IsHexHash(snapshot.BlockHash) {
		return "", errSimulationEvidence
	}
	input, err := hexutil.Decode(tx.Data)
	if err != nil {
		return "", errSimulationEvidence
	}
	call := map[string]string{
		"from":  tx.From,
		"to":    tx.To,
		"data":  tx.Data,
		"value": "0x0",
		"gas":   hexutil.EncodeUint64(gas),
	}
	block := gethrpc.BlockNumberOrHashWithHash(common.HexToHash(snapshot.BlockHash), true)
	options := map[string]any{
		"tracer":       "callTracer",
		"tracerConfig": map[string]bool{"withLog": true},
	}
	var trace anvilTrace
	if err := s.client.CallContext(ctx, &trace, "debug_traceCall", call, block, options); err != nil {
		return "", errSimulationUnavailable
	}
	if !strings.EqualFold(trace.From.Hex(), tx.From) || !strings.EqualFold(trace.To.Hex(), tx.To) || !strings.EqualFold(hexutil.Encode(trace.Input), hexutil.Encode(input)) {
		return "", errSimulationEvidence
	}
	var logs []struct {
		Address common.Address `json:"address"`
		Topics  []common.Hash  `json:"topics"`
		Data    hexutil.Bytes  `json:"data"`
	}
	var collect func(anvilTrace) bool
	collect = func(call anvilTrace) bool {
		if call.Error != "" {
			return false
		}
		logs = append(logs, call.Logs...)
		for _, child := range call.Calls {
			if !collect(child) {
				return false
			}
		}
		return true
	}
	if !collect(trace) {
		return "", errSimulationEvidence
	}
	delta := func(probe BalanceProbe) (*big.Int, bool) {
		if !validAddress(probe.Token) || !validAddress(probe.Owner) {
			return nil, false
		}
		token, owner := common.HexToAddress(probe.Token), common.HexToAddress(probe.Owner)
		result := new(big.Int)
		for _, log := range logs {
			if log.Address != token || len(log.Topics) != 3 || log.Topics[0] != transferTopic || len(log.Data) != 32 {
				continue
			}
			value := new(big.Int).SetBytes(log.Data)
			from := common.BytesToAddress(log.Topics[1].Bytes()[12:])
			to := common.BytesToAddress(log.Topics[2].Bytes()[12:])
			if from == owner {
				result.Sub(result, value)
			}
			if to == owner {
				result.Add(result, value)
			}
		}
		return result, true
	}
	inputDelta, ok := delta(checks.Input)
	if !ok || new(big.Int).Neg(inputDelta).Cmp(amount) != 0 {
		return "", errSimulationInputAmount
	}
	output, ok := delta(checks.Output)
	if !ok || output.Cmp(minimum) < 0 {
		return "", errSimulationMinimumOutput
	}
	for _, probe := range checks.Preserve {
		value, ok := delta(probe)
		if !ok || value.Sign() != 0 {
			return "", errSimulationProtectedBalance
		}
	}
	return output.String(), nil
}
