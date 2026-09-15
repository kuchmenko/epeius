package quote

import (
	"context"
	"encoding/json"
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
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	rpccontext "github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

var transferTopic = common.HexToHash("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")

// AnvilSimulator is an explicit local-fork test adapter. It only traces a
// call; it never signs, submits, impersonates, or changes fork state.
type AnvilSimulator struct {
	client  *gethrpc.Client
	chainID string
}

type anvilLog struct {
	Address common.Address `json:"address"`
	Topics  []common.Hash  `json:"topics"`
	Data    hexutil.Bytes  `json:"data"`
}

type anvilTrace struct {
	From  common.Address `json:"from"`
	To    common.Address `json:"to"`
	Input hexutil.Bytes  `json:"input"`
	Error string         `json:"error"`
	Logs  []anvilLog     `json:"logs"`
	Calls []anvilTrace   `json:"calls"`
}

type anvilSimulationCall struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Data  string `json:"data"`
	Value string `json:"value"`
	Gas   string `json:"gas"`
}

type anvilSimulationResult struct {
	Status     string          `json:"status"`
	ReturnData string          `json:"returnData"`
	Logs       []anvilLog      `json:"logs"`
	Error      json.RawMessage `json:"error"`
}

type anvilSimulationTransaction struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Input string `json:"input"`
	Value string `json:"value"`
	Gas   string `json:"gas"`
	Hash  string `json:"hash"`
}

type anvilSimulationBlock struct {
	Number       string                       `json:"number"`
	Hash         string                       `json:"hash"`
	ParentHash   string                       `json:"parentHash"`
	Transactions []anvilSimulationTransaction `json:"transactions"`
	Calls        []anvilSimulationResult      `json:"calls"`
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
	result, err := s.SimulateAtomic(ctx, tx, checks, snapshot, amount, minimum)
	return result.Output, err
}

func (s *AnvilSimulator) SimulateAtomic(ctx context.Context, tx *quotev1.UnsignedTransaction, checks SimulationChecks, snapshot rpccontext.Snapshot, amount, minimum *big.Int) (SimulationResult, error) {
	if tx.ChainId != s.chainID || tx.ChainId != snapshot.ChainID || tx.ValueAtomic != "0" || !validAddress(tx.From) || !validAddress(tx.To) {
		return SimulationResult{}, errSimulationEvidence
	}
	for _, probe := range checks.ClearAllowances {
		if !validAddress(probe.Token) || !validAddress(probe.Owner) || !validAddress(probe.Spender) {
			return SimulationResult{}, errSimulationEvidence
		}
	}
	gas, err := strconv.ParseUint(tx.GasLimit, 10, 64)
	if err != nil || gas == 0 || !common.IsHexHash(snapshot.BlockHash) {
		return SimulationResult{}, errSimulationEvidence
	}
	input, err := hexutil.Decode(tx.Data)
	if err != nil {
		return SimulationResult{}, errSimulationEvidence
	}
	call := map[string]string{
		"from":  tx.From,
		"to":    tx.To,
		"data":  tx.Data,
		"value": "0x0",
		"gas":   hexutil.EncodeUint64(gas),
	}
	var logs []anvilLog
	if len(checks.ClearAllowances) != 0 {
		logs, err = s.simulateAllowanceBundle(ctx, tx, checks.ClearAllowances, snapshot, gas)
		if err != nil {
			return SimulationResult{}, err
		}
	} else {
		block := gethrpc.BlockNumberOrHashWithHash(common.HexToHash(snapshot.BlockHash), true)
		options := map[string]any{
			"tracer":       "callTracer",
			"tracerConfig": map[string]bool{"withLog": true},
		}
		var trace anvilTrace
		if err := s.client.CallContext(ctx, &trace, "debug_traceCall", call, block, options); err != nil {
			return SimulationResult{}, errSimulationUnavailable
		}
		if !strings.EqualFold(trace.From.Hex(), tx.From) || !strings.EqualFold(trace.To.Hex(), tx.To) || !strings.EqualFold(hexutil.Encode(trace.Input), hexutil.Encode(input)) {
			return SimulationResult{}, errSimulationEvidence
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
			return SimulationResult{}, errSimulationEvidence
		}
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
		return SimulationResult{}, errSimulationInputAmount
	}
	output, ok := delta(checks.Output)
	if !ok || output.Cmp(minimum) < 0 {
		return SimulationResult{}, errSimulationMinimumOutput
	}
	for _, probe := range checks.Preserve {
		value, ok := delta(probe)
		if !ok || value.Sign() != 0 {
			return SimulationResult{}, errSimulationProtectedBalance
		}
	}
	resultLogs := make([]SimulationLog, len(logs))
	for i, log := range logs {
		resultLogs[i] = SimulationLog{Address: log.Address, Topics: append([]common.Hash(nil), log.Topics...), Data: append([]byte(nil), log.Data...)}
	}
	return SimulationResult{Output: output.String(), Logs: resultLogs}, nil
}

// eth_simulateV1 executes calls in order against one ephemeral state. Full
// transaction results bind each returned call to the exact request before its
// ABI result can prove cleanup. See https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth_simulatev1.
func (s *AnvilSimulator) simulateAllowanceBundle(ctx context.Context, tx *quotev1.UnsignedTransaction, probes []AllowanceProbe, snapshot rpccontext.Snapshot, gas uint64) ([]anvilLog, error) {
	number, ok := new(big.Int).SetString(snapshot.BlockNumber, 10)
	if !ok || number.Sign() < 0 {
		return nil, errSimulationEvidence
	}
	var parent *anvilSimulationBlock
	if err := s.client.CallContext(ctx, &parent, "eth_getBlockByHash", snapshot.BlockHash, false); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errSimulationTimeout
		}
		return nil, errSimulationUnavailable
	}
	if parent == nil || !strings.EqualFold(parent.Hash, snapshot.BlockHash) || !sameQuantity(parent.Number, number) || !common.IsHexHash(parent.ParentHash) {
		return nil, errSimulationEvidence
	}
	calls := make([]anvilSimulationCall, 1, len(probes)+1)
	calls[0] = anvilSimulationCall{From: tx.From, To: tx.To, Data: tx.Data, Value: "0x0", Gas: hexutil.EncodeUint64(gas)}
	for _, probe := range probes {
		data, _ := erc20ABI.Pack("allowance", common.HexToAddress(probe.Owner), common.HexToAddress(probe.Spender))
		calls = append(calls, anvilSimulationCall{From: tx.From, To: probe.Token, Data: hexutil.Encode(data), Value: "0x0", Gas: hexutil.EncodeUint64(gas)})
	}
	payload := struct {
		BlockStateCalls []struct {
			Calls []anvilSimulationCall `json:"calls"`
		} `json:"blockStateCalls"`
		Validation             bool `json:"validation"`
		TraceTransfers         bool `json:"traceTransfers"`
		ReturnFullTransactions bool `json:"returnFullTransactions"`
	}{ReturnFullTransactions: true}
	payload.BlockStateCalls = append(payload.BlockStateCalls, struct {
		Calls []anvilSimulationCall `json:"calls"`
	}{Calls: calls})
	var blocks []anvilSimulationBlock
	block := gethrpc.BlockNumberOrHashWithHash(common.HexToHash(snapshot.BlockHash), true)
	if err := s.client.CallContext(ctx, &blocks, "eth_simulateV1", payload, block); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errSimulationTimeout
		}
		return nil, errSimulationUnavailable
	}
	if len(blocks) != 1 || !sameQuantity(blocks[0].Number, number) || !strings.EqualFold(blocks[0].ParentHash, parent.ParentHash) || !common.IsHexHash(blocks[0].Hash) || len(blocks[0].Calls) != len(calls) || len(blocks[0].Transactions) != len(calls) {
		return nil, errSimulationEvidence
	}
	for i, expected := range calls {
		transaction, result := blocks[0].Transactions[i], blocks[0].Calls[i]
		if !strings.EqualFold(transaction.From, expected.From) || !strings.EqualFold(transaction.To, expected.To) || !strings.EqualFold(transaction.Input, expected.Data) || !sameQuantityString(transaction.Value, expected.Value) || !sameQuantityString(transaction.Gas, expected.Gas) || !common.IsHexHash(transaction.Hash) || result.Status != "0x1" || len(result.Error) != 0 && string(result.Error) != "null" {
			return nil, errSimulationEvidence
		}
		decoded, err := hexutil.Decode(result.ReturnData)
		if err != nil || !strings.EqualFold(hexutil.Encode(decoded), result.ReturnData) {
			return nil, errSimulationEvidence
		}
		if i == 0 {
			if len(decoded) != 0 {
				return nil, errSimulationEvidence
			}
			continue
		}
		values, err := evm.Unpack(erc20ABI.Methods["allowance"], decoded)
		if err != nil {
			return nil, errSimulationEvidence
		}
		if values[0].(*big.Int).Sign() != 0 {
			return nil, errSimulationAllowance
		}
		if len(result.Logs) != 0 {
			return nil, errSimulationEvidence
		}
	}
	return blocks[0].Calls[0].Logs, nil
}

func sameQuantity(value string, expected *big.Int) bool {
	decoded, err := hexutil.DecodeBig(value)
	return err == nil && decoded.Cmp(expected) == 0 && hexutil.EncodeBig(decoded) == value
}

func sameQuantityString(value, expected string) bool {
	decoded, err := hexutil.DecodeBig(value)
	want, wantErr := hexutil.DecodeBig(expected)
	return err == nil && wantErr == nil && decoded.Cmp(want) == 0 && hexutil.EncodeBig(decoded) == value
}
