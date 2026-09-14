package quote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"slices"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/balancer"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/uniswapv4"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
	"google.golang.org/protobuf/proto"
)

type atomicCandidateFixture struct {
	FormatVersion     uint32   `json:"formatVersion"`
	ChainID           string   `json:"chainId"`
	TokenIn           string   `json:"tokenIn"`
	IntermediateToken string   `json:"intermediateToken"`
	TokenOut          string   `json:"tokenOut"`
	AmountIn          string   `json:"amountIn"`
	Factory           string   `json:"factory"`
	Router            string   `json:"router"`
	Vault             string   `json:"vault"`
	PoolID            string   `json:"poolId"`
	PoolManager       string   `json:"poolManager"`
	Currency0         string   `json:"currency0"`
	Currency1         string   `json:"currency1"`
	Hooks             string   `json:"hooks"`
	Pools             []string `json:"pools"`
	Fees              []uint32 `json:"fees"`
	FeePips           uint32   `json:"feePips"`
	TickSpacing       int32    `json:"tickSpacing"`
	TickSpacings      []int32  `json:"tickSpacings"`
	OperationOutputs  []string `json:"operationOutputs"`
	QuoteBlockNumber  string   `json:"quoteBlockNumber"`
	QuoteBlockHash    string   `json:"quoteBlockHash"`
	CandidateID       string   `json:"candidateId"`
	Executor          string   `json:"executor"`
	Signer            string   `json:"signer"`
	Minimum           string   `json:"minimum"`
	RuntimeCodeHash   string   `json:"runtimeCodeHash"`
	ExpiresAtUnix     string   `json:"expiresAtUnix"`
	DeadlineUnix      string   `json:"deadlineUnix"`
	GasLimit          string   `json:"gasLimit"`
	PlanID            string   `json:"planId"`
	ExecutorPlanHash  string   `json:"executorPlanHash"`
	Fingerprint       string   `json:"transactionFingerprint"`
	CalldataHash      string   `json:"executorCalldataHash"`
	ProviderHashes    []string `json:"providerHashes"`
	OperationHashes   []string `json:"operationHashes"`
}

func loadUniswapV4AtomicFixture(t *testing.T) atomicCandidateFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-uniswap-v4.json")
	if err != nil {
		t.Fatal(err)
	}
	var result atomicCandidateFixture
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func loadBalancerAtomicFixture(t *testing.T) atomicCandidateFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-balancer.json")
	if err != nil {
		t.Fatal(err)
	}
	var result atomicCandidateFixture
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func loadSlipstreamAtomicFixture(t *testing.T) atomicCandidateFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-slipstream.json")
	if err != nil {
		t.Fatal(err)
	}
	var result atomicCandidateFixture
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func loadPancakeAtomicFixture(t *testing.T) atomicCandidateFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-pancake.json")
	if err != nil {
		t.Fatal(err)
	}
	var result atomicCandidateFixture
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func loadAtomicCandidateFixture(t *testing.T) atomicCandidateFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/fixtures/atomic-v1-candidate.json")
	if err != nil {
		t.Fatal(err)
	}
	var result atomicCandidateFixture
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestAtomicCandidateHashMatchesIndependentCastVector(t *testing.T) {
	f := loadAtomicCandidateFixture(t)
	chainID, _ := new(big.Int).SetString(f.ChainID, 10)
	amount, _ := new(big.Int).SetString(f.AmountIn, 10)
	blockNumber, _ := new(big.Int).SetString(f.QuoteBlockNumber, 10)
	outputs := make([]*big.Int, len(f.OperationOutputs))
	for i, value := range f.OperationOutputs {
		outputs[i], _ = new(big.Int).SetString(value, 10)
	}
	item := candidate{
		tokens: []common.Address{common.HexToAddress(f.TokenIn), common.HexToAddress(f.IntermediateToken), common.HexToAddress(f.TokenOut)},
		fees:   f.Fees,
	}
	pools := []common.Address{common.HexToAddress(f.Pools[0]), common.HexToAddress(f.Pools[1])}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(f.QuoteBlockHash).Bytes()}
	value, err := atomicPlanCandidate(chainID, amount, common.HexToAddress(f.TokenIn), common.HexToAddress(f.TokenOut), config.Deployment{Factory: f.Factory, Router: f.Router}, item, block, outputs, pools)
	if err != nil {
		t.Fatal(err)
	}
	if common.BytesToHash(value.CandidateId).Hex() != f.CandidateID || len(value.BranchQuotes) != 1 || len(value.BranchQuotes[0].OperationOutputs) != 2 || new(big.Int).SetBytes(value.BranchQuotes[0].OperationOutputs[0]).String() != f.OperationOutputs[0] {
		t.Fatalf("candidate does not match Cast vector: %+v", value)
	}
}

func TestUniswapV4AtomicIdentitiesMatchIndependentCastVector(t *testing.T) {
	f := loadUniswapV4AtomicFixture(t)
	chainID, _ := new(big.Int).SetString(f.ChainID, 10)
	amount, _ := new(big.Int).SetString(f.AmountIn, 10)
	minimum, _ := new(big.Int).SetString(f.Minimum, 10)
	blockNumber, _ := new(big.Int).SetString(f.QuoteBlockNumber, 10)
	expires, _ := new(big.Int).SetString(f.ExpiresAtUnix, 10)
	deadline, _ := new(big.Int).SetString(f.DeadlineUnix, 10)
	output, _ := new(big.Int).SetString(f.OperationOutputs[0], 10)
	options := uniswapv4.Options{PoolManager: f.PoolManager, Pools: []uniswapv4.Pool{{Currency0: f.Currency0, Currency1: f.Currency1, FeePips: f.FeePips, TickSpacing: f.TickSpacing, Hooks: f.Hooks}}}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(f.QuoteBlockHash).Bytes()}
	candidate, err := atomicV4Candidate(chainID, amount, common.HexToAddress(f.TokenIn), common.HexToAddress(f.TokenOut), options, options.Pools[0], block, output)
	if err != nil || common.BytesToHash(candidate.CandidateId).Hex() != f.CandidateID || candidate.Program.Branches[0].Operations[0].GetUniswapV4() == nil {
		t.Fatalf("Uniswap V4 candidate mismatch: %+v %v", candidate, err)
	}
	terms := &atomicv1.AcceptedPlanTerms{
		Program: candidate.Program, Executor: &atomicv1.ExecutorIdentity{Address: common.HexToAddress(f.Executor).Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: common.HexToHash(f.RuntimeCodeHash).Bytes()}, Signer: common.HexToAddress(f.Signer).Bytes(), Recipient: common.HexToAddress(f.Signer).Bytes(), BranchMinima: [][]byte{uint256Bytes(minimum)}, AmountOutMinimum: uint256Bytes(minimum), QuoteBlock: block, ExpiresAtUnix: uint256Bytes(expires), DeadlineUnix: uint256Bytes(deadline),
	}
	planID, planErr := atomicV1PlanID(terms)
	operation := atomicV1Operation{Kind: 5, TokenOut: common.HexToAddress(f.TokenOut), Fee: new(big.Int).SetUint64(uint64(f.FeePips)), TickSpacing: big.NewInt(int64(f.TickSpacing))}
	plan := atomicV1ExecutorPlan{TokenIn: common.HexToAddress(f.TokenIn), TokenOut: common.HexToAddress(f.TokenOut), AmountIn: amount, MinAmountOut: minimum, Deadline: deadline, Branches: []atomicV1Branch{{AmountIn: amount, MinAmountOut: minimum, Operations: []atomicV1Operation{operation}}}}
	executorHash, hashErr := atomicV1ExecutorPlanHash(f.ChainID, common.HexToAddress(f.Executor), common.HexToAddress(f.Signer), plan)
	data, packErr := contractabi.ExecutorV2.Pack("execute", plan)
	tx := &quotev1.UnsignedTransaction{ChainId: f.ChainID, From: f.Signer, To: f.Executor, ValueAtomic: "0", Data: hexutil.Encode(data), GasLimit: f.GasLimit}
	fingerprint, fingerprintErr := atomicV1TransactionFingerprint(planID, tx)
	if planErr != nil || hashErr != nil || packErr != nil || fingerprintErr != nil || planID.Hex() != f.PlanID || executorHash.Hex() != f.ExecutorPlanHash || crypto.Keccak256Hash(data).Hex() != f.CalldataHash || fingerprint.Hex() != f.Fingerprint {
		t.Fatalf("Uniswap V4 identities differ: plan=%s executor=%s calldata=%s fingerprint=%s", planID.Hex(), executorHash.Hex(), crypto.Keccak256Hash(data).Hex(), fingerprint.Hex())
	}
	options.Permit2 = common.HexToAddress("0x7777777777777777777777777777777777777777").Hex()
	configured := Chain{ChainID: f.ChainID, Config: config.Chain{
		AtomicExecutor: &config.AtomicExecutor{Address: f.Executor, RuntimeCodeHash: f.RuntimeCodeHash, UniswapV4Deployment: "v4"},
		Deployments:    map[string]config.Deployment{"v4": {Kind: "uniswap-v4", Router: common.HexToAddress("0x8888888888888888888888888888888888888888").Hex(), ProviderConfig: options}},
	}}
	validated, validationErr := validateAcceptedAtomicTerms(configured, terms, planID.Bytes(), time.Unix(1_999_999_000, 0))
	if validationErr != nil || crypto.Keccak256Hash(common.FromHex(validated.transaction.Data)).Hex() != f.CalldataHash || len(validated.checks.ClearAllowances) != 1 || validated.checks.ClearAllowances[0].Spender != options.Permit2 {
		t.Fatalf("Uniswap V4 accepted terms were not reconstructed exactly: %+v %v", validated, validationErr)
	}
}

func TestPancakeAtomicIdentitiesMatchIndependentCastVector(t *testing.T) {
	f := loadPancakeAtomicFixture(t)
	chainID, _ := new(big.Int).SetString(f.ChainID, 10)
	amount, _ := new(big.Int).SetString(f.AmountIn, 10)
	minimum, _ := new(big.Int).SetString(f.Minimum, 10)
	blockNumber, _ := new(big.Int).SetString(f.QuoteBlockNumber, 10)
	expires, _ := new(big.Int).SetString(f.ExpiresAtUnix, 10)
	deadline, _ := new(big.Int).SetString(f.DeadlineUnix, 10)
	outputs := make([]*big.Int, len(f.OperationOutputs))
	for i, value := range f.OperationOutputs {
		outputs[i], _ = new(big.Int).SetString(value, 10)
	}
	item := candidate{tokens: []common.Address{common.HexToAddress(f.TokenIn), common.HexToAddress(f.IntermediateToken), common.HexToAddress(f.TokenOut)}, fees: f.Fees}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(f.QuoteBlockHash).Bytes()}
	candidate, err := atomicPlanCandidate(chainID, amount, common.HexToAddress(f.TokenIn), common.HexToAddress(f.TokenOut), config.Deployment{Kind: "pancake-v3", Factory: f.Factory, Router: f.Router}, item, block, outputs, []common.Address{common.HexToAddress(f.Pools[0]), common.HexToAddress(f.Pools[1])})
	if err != nil || common.BytesToHash(candidate.CandidateId).Hex() != f.CandidateID || candidate.Program.Branches[0].Operations[0].GetPancakeV3() == nil {
		t.Fatalf("Pancake candidate mismatch: %+v %v", candidate, err)
	}
	wire, err := proto.Marshal(candidate)
	decoded := new(atomicv1.PlanCandidate)
	if err != nil || proto.Unmarshal(wire, decoded) != nil || decoded.Program.Branches[0].Operations[0].GetPancakeV3() == nil || decoded.Program.Branches[0].Operations[0].GetUniswapV3() != nil {
		t.Fatal("Pancake operation oneof did not survive binary transport")
	}
	terms := &atomicv1.AcceptedPlanTerms{
		Program: candidate.Program, Executor: &atomicv1.ExecutorIdentity{Address: common.HexToAddress(f.Executor).Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: common.HexToHash(f.RuntimeCodeHash).Bytes()}, Signer: common.HexToAddress(f.Signer).Bytes(), Recipient: common.HexToAddress(f.Signer).Bytes(), BranchMinima: [][]byte{uint256Bytes(minimum)}, AmountOutMinimum: uint256Bytes(minimum), QuoteBlock: block, ExpiresAtUnix: uint256Bytes(expires), DeadlineUnix: uint256Bytes(deadline),
	}
	planID, err := atomicV1PlanID(terms)
	operations := []atomicV1Operation{{Kind: 2, TokenOut: common.HexToAddress(f.IntermediateToken), Fee: new(big.Int).SetUint64(uint64(f.Fees[0])), TickSpacing: new(big.Int)}, {Kind: 2, TokenOut: common.HexToAddress(f.TokenOut), Fee: new(big.Int).SetUint64(uint64(f.Fees[1])), TickSpacing: new(big.Int)}}
	plan := atomicV1ExecutorPlan{TokenIn: common.HexToAddress(f.TokenIn), TokenOut: common.HexToAddress(f.TokenOut), AmountIn: amount, MinAmountOut: minimum, Deadline: deadline, Branches: []atomicV1Branch{{AmountIn: amount, MinAmountOut: minimum, Operations: operations}}}
	executorHash, hashErr := atomicV1ExecutorPlanHash(f.ChainID, common.HexToAddress(f.Executor), common.HexToAddress(f.Signer), plan)
	data, packErr := contractabi.ExecutorV2.Pack("execute", plan)
	gas, _ := new(big.Int).SetString(f.GasLimit, 10)
	tx := &quotev1.UnsignedTransaction{ChainId: f.ChainID, From: f.Signer, To: f.Executor, ValueAtomic: "0", Data: hexutil.Encode(data), GasLimit: gas.String()}
	fingerprint, fingerprintErr := atomicV1TransactionFingerprint(planID, tx)
	if err != nil || hashErr != nil || packErr != nil || fingerprintErr != nil || planID.Hex() != f.PlanID || executorHash.Hex() != f.ExecutorPlanHash || crypto.Keccak256Hash(data).Hex() != f.CalldataHash || fingerprint.Hex() != f.Fingerprint {
		t.Fatalf("Pancake identities differ: plan=%s executor=%s calldata=%s fingerprint=%s", planID.Hex(), executorHash.Hex(), crypto.Keccak256Hash(data).Hex(), fingerprint.Hex())
	}
}

func TestSlipstreamAtomicIdentitiesMatchIndependentCastVector(t *testing.T) {
	f := loadSlipstreamAtomicFixture(t)
	chainID, _ := new(big.Int).SetString(f.ChainID, 10)
	amount, _ := new(big.Int).SetString(f.AmountIn, 10)
	minimum, _ := new(big.Int).SetString(f.Minimum, 10)
	blockNumber, _ := new(big.Int).SetString(f.QuoteBlockNumber, 10)
	expires, _ := new(big.Int).SetString(f.ExpiresAtUnix, 10)
	deadline, _ := new(big.Int).SetString(f.DeadlineUnix, 10)
	outputs := make([]*big.Int, len(f.OperationOutputs))
	for i, value := range f.OperationOutputs {
		outputs[i], _ = new(big.Int).SetString(value, 10)
	}
	item := candidate{tokens: []common.Address{common.HexToAddress(f.TokenIn), common.HexToAddress(f.IntermediateToken), common.HexToAddress(f.TokenOut)}, spacings: f.TickSpacings}
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(f.QuoteBlockHash).Bytes()}
	candidate, err := atomicPlanCandidate(chainID, amount, common.HexToAddress(f.TokenIn), common.HexToAddress(f.TokenOut), config.Deployment{Kind: "aerodrome-slipstream", Factory: f.Factory, Router: f.Router}, item, block, outputs, []common.Address{common.HexToAddress(f.Pools[0]), common.HexToAddress(f.Pools[1])})
	if err != nil || common.BytesToHash(candidate.CandidateId).Hex() != f.CandidateID || candidate.Program.Branches[0].Operations[0].GetSlipstreamInitial() == nil {
		t.Fatalf("Slipstream candidate mismatch: %+v %v", candidate, err)
	}
	terms := &atomicv1.AcceptedPlanTerms{
		Program: candidate.Program, Executor: &atomicv1.ExecutorIdentity{Address: common.HexToAddress(f.Executor).Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: common.HexToHash(f.RuntimeCodeHash).Bytes()}, Signer: common.HexToAddress(f.Signer).Bytes(), Recipient: common.HexToAddress(f.Signer).Bytes(), BranchMinima: [][]byte{uint256Bytes(minimum)}, AmountOutMinimum: uint256Bytes(minimum), QuoteBlock: block, ExpiresAtUnix: uint256Bytes(expires), DeadlineUnix: uint256Bytes(deadline),
	}
	planID, err := atomicV1PlanID(terms)
	operations := []atomicV1Operation{{Kind: 3, TokenOut: common.HexToAddress(f.IntermediateToken), Fee: new(big.Int), TickSpacing: big.NewInt(int64(f.TickSpacings[0]))}, {Kind: 3, TokenOut: common.HexToAddress(f.TokenOut), Fee: new(big.Int), TickSpacing: big.NewInt(int64(f.TickSpacings[1]))}}
	plan := atomicV1ExecutorPlan{TokenIn: common.HexToAddress(f.TokenIn), TokenOut: common.HexToAddress(f.TokenOut), AmountIn: amount, MinAmountOut: minimum, Deadline: deadline, Branches: []atomicV1Branch{{AmountIn: amount, MinAmountOut: minimum, Operations: operations}}}
	executorHash, hashErr := atomicV1ExecutorPlanHash(f.ChainID, common.HexToAddress(f.Executor), common.HexToAddress(f.Signer), plan)
	data, packErr := contractabi.ExecutorV2.Pack("execute", plan)
	gas, _ := new(big.Int).SetString(f.GasLimit, 10)
	tx := &quotev1.UnsignedTransaction{ChainId: f.ChainID, From: f.Signer, To: f.Executor, ValueAtomic: "0", Data: hexutil.Encode(data), GasLimit: gas.String()}
	fingerprint, fingerprintErr := atomicV1TransactionFingerprint(planID, tx)
	if err != nil || hashErr != nil || packErr != nil || fingerprintErr != nil || planID.Hex() != f.PlanID || executorHash.Hex() != f.ExecutorPlanHash || crypto.Keccak256Hash(data).Hex() != f.CalldataHash || fingerprint.Hex() != f.Fingerprint {
		t.Fatalf("Slipstream identities differ: plan=%s executor=%s calldata=%s fingerprint=%s", planID.Hex(), executorHash.Hex(), crypto.Keccak256Hash(data).Hex(), fingerprint.Hex())
	}

	negative := proto.CloneOf(candidate)
	negative.Program.Branches[0].Operations[0].GetSlipstreamInitial().TickSpacing = proto.Int32(-f.TickSpacings[0])
	negativeHash, hashErr := atomicCandidateHash(negative.Program, negative.QuoteBlock, negative.BranchQuotes)
	if hashErr != nil || negativeHash == common.BytesToHash(candidate.CandidateId) {
		t.Fatal("negative signed spacing did not produce a distinct candidate identity")
	}
}

func TestBalancerAtomicIdentityVector(t *testing.T) {
	f := loadBalancerAtomicFixture(t)
	chainID, _ := new(big.Int).SetString(f.ChainID, 10)
	amount, _ := new(big.Int).SetString(f.AmountIn, 10)
	minimum, _ := new(big.Int).SetString(f.Minimum, 10)
	blockNumber, _ := new(big.Int).SetString(f.QuoteBlockNumber, 10)
	expires, _ := new(big.Int).SetString(f.ExpiresAtUnix, 10)
	deadline, _ := new(big.Int).SetString(f.DeadlineUnix, 10)
	output, _ := new(big.Int).SetString(f.OperationOutputs[0], 10)
	vault, poolID := common.HexToAddress(f.Vault), common.HexToHash(f.PoolID)
	in, out := common.HexToAddress(f.TokenIn), common.HexToAddress(f.TokenOut)
	block := &atomicv1.PinnedBlock{Number: uint256Bytes(blockNumber), Hash: common.HexToHash(f.QuoteBlockHash).Bytes()}
	candidate, err := atomicBalancerCandidate(chainID, amount, in, out, vault, poolID, block, output)
	if err != nil {
		t.Fatal(err)
	}
	provider, _ := atomicHash(abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint8")}, {Type: atomicABIType("address")}, {Type: atomicABIType("bytes32")}}, atomicCandidateProviderDomain, uint8(4), vault, poolID)
	operation, _ := atomicHash(abi.Arguments{{Type: atomicABIType("bytes32")}, {Type: atomicABIType("uint8")}, {Type: atomicABIType("address")}, {Type: atomicABIType("address")}, {Type: atomicABIType("bytes32")}}, atomicCandidateOperationDomain, uint8(4), in, out, provider)
	executor, signer := common.HexToAddress(f.Executor), common.HexToAddress(f.Signer)
	terms := &atomicv1.AcceptedPlanTerms{Program: candidate.Program, Executor: &atomicv1.ExecutorIdentity{Address: executor.Bytes(), Version: proto.Uint32(2), RuntimeCodeHash: common.HexToHash(f.RuntimeCodeHash).Bytes()}, Signer: signer.Bytes(), Recipient: signer.Bytes(), BranchMinima: [][]byte{uint256Bytes(minimum)}, AmountOutMinimum: uint256Bytes(minimum), QuoteBlock: block, ExpiresAtUnix: uint256Bytes(expires), DeadlineUnix: uint256Bytes(deadline)}
	planID, _ := atomicV1PlanID(terms)
	plan := atomicV1ExecutorPlan{TokenIn: in, TokenOut: out, AmountIn: amount, MinAmountOut: minimum, Deadline: deadline, Branches: []atomicV1Branch{{AmountIn: amount, MinAmountOut: minimum, Operations: []atomicV1Operation{{Kind: 4, TokenOut: out, Fee: new(big.Int), TickSpacing: new(big.Int), PoolId: poolID}}}}}
	data, _ := contractabi.ExecutorV2.Pack("execute", plan)
	executorHash, _ := atomicV1ExecutorPlanHash(f.ChainID, executor, signer, plan)
	tx := &quotev1.UnsignedTransaction{ChainId: f.ChainID, From: signer.Hex(), To: executor.Hex(), Data: hexutil.Encode(data), ValueAtomic: "0", GasLimit: f.GasLimit}
	fingerprint, _ := atomicV1TransactionFingerprint(planID, tx)
	want := []string{f.ProviderHashes[0], f.OperationHashes[0], f.CandidateID, f.PlanID, f.ExecutorPlanHash, f.CalldataHash, f.Fingerprint}
	got := []string{provider.Hex(), operation.Hex(), common.BytesToHash(candidate.CandidateId).Hex(), planID.Hex(), executorHash.Hex(), crypto.Keccak256Hash(data).Hex(), fingerprint.Hex()}
	if !slices.Equal(got, want) {
		t.Fatalf("Balancer identity vector differs: %v", got)
	}
	mutated := proto.CloneOf(candidate)
	mutated.Program.Branches[0].Operations[0].GetBalancerV2().PoolId[31] ^= 1
	mutatedHash, err := atomicCandidateHash(mutated.Program, mutated.QuoteBlock, mutated.BranchQuotes)
	if err != nil || mutatedHash == common.BytesToHash(candidate.CandidateId) {
		t.Fatal("full pool ID suffix is absent from candidate identity")
	}
}

func TestAtomicPoolKeyIncludesProviderAndItsExactSelector(t *testing.T) {
	tokenA := common.HexToAddress("0x0000000000000000000000000000000000000011")
	tokenB := common.HexToAddress("0x0000000000000000000000000000000000000022")
	uniswap := atomicV1PoolKeyFromValues(1, tokenA, tokenB, 100, 0)
	if uniswap != atomicV1PoolKeyFromValues(1, tokenB, tokenA, 100, 0) {
		t.Fatal("reverse direction changed one physical pool key")
	}
	for name, key := range map[string]string{
		"other fee":           atomicV1PoolKeyFromValues(1, tokenA, tokenB, 200, 0),
		"other provider":      atomicV1PoolKeyFromValues(2, tokenA, tokenB, 100, 0),
		"Slipstream selector": atomicV1PoolKeyFromValues(3, tokenA, tokenB, 0, 100),
		"other tick spacing":  atomicV1PoolKeyFromValues(3, tokenA, tokenB, 0, 200),
	} {
		if key == uniswap {
			t.Fatalf("%s did not change physical pool key", name)
		}
	}
}

func atomicQuoteRequest(chainID string, in, out common.Address, amount string) *atomicv1.PlanQuoteRequest {
	chain, _ := new(big.Int).SetString(chainID, 10)
	input, _ := new(big.Int).SetString(amount, 10)
	return &atomicv1.PlanQuoteRequest{
		FormatVersion: proto.Uint32(1), ChainId: uint256Bytes(chain), TokenIn: in.Bytes(), TokenOut: out.Bytes(), AmountIn: uint256Bytes(input), SearchBudgetMs: proto.Uint32(500),
	}
}

func atomicQuoteConfig(middle common.Address) config.Chain {
	return config.Chain{
		Tokens:         []config.Token{{Address: testWETH.Hex()}, {Address: middle.Hex()}, {Address: testUSDC.Hex()}},
		Deployments:    map[string]config.Deployment{"uni": {Kind: "uniswap-v3", Factory: testFactory.Hex(), Quoter: testQuoter.Hex(), Router: common.HexToAddress("0x5555").Hex(), Fees: []uint32{3000, 500}}},
		AtomicExecutor: &config.AtomicExecutor{Address: common.HexToAddress("0x4444").Hex(), RuntimeCodeHash: common.HexToHash("0x11").Hex(), UniswapDeployment: "uni"},
	}
}

func TestAtomicPlanQuoteCanonicalPathsUseSequentialOutputs(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	reader := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
			if hash != common.HexToHash(blockHash) {
				t.Fatal("quote did not use the pinned block")
			}
			if to == testFactory {
				return poolResponse(common.BytesToAddress(crypto.Keccak256(data)[12:])), nil
			}
			if calldataFee(data) == 500 {
				time.Sleep(3 * time.Millisecond)
			}
			input := new(big.Int).SetBytes(data[68:100]).Uint64()
			return quoteResponse(input*2 + uint64(calldataFee(data))), nil
		},
	}
	handler := Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: atomicQuoteConfig(middle)}}, QuoteConcurrency: 3}
	response, err := handler.GetPlanQuote(context.Background(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	if err != nil {
		t.Fatal(err)
	}
	got := response.Msg
	if got.SearchComplete == nil || !got.GetSearchComplete() || len(got.QuoteId) != 32 || len(got.Candidates) != 6 {
		t.Fatalf("unexpected result: %+v", got)
	}
	wantHops := []int{1, 1, 2, 2, 2, 2}
	for i, value := range got.Candidates {
		operations := value.Program.Branches[0].Operations
		outputs := value.BranchQuotes[0].OperationOutputs
		if len(operations) != wantHops[i] || len(outputs) != wantHops[i] || value.NetworkCostOut != nil || len(value.CandidateId) != 32 {
			t.Fatalf("candidate %d has wrong structure", i)
		}
		if len(outputs) == 2 {
			first := new(big.Int).SetBytes(outputs[0]).Uint64()
			second := new(big.Int).SetBytes(outputs[1]).Uint64()
			secondFee := uint64(operations[1].GetUniswapV3().GetFeePips())
			if second != first*2+secondFee {
				t.Fatalf("candidate %d did not preserve sequential outputs", i)
			}
		}
	}
	if got.Candidates[0].Program.Branches[0].Operations[0].GetUniswapV3().GetFeePips() != 500 || got.Candidates[1].Program.Branches[0].Operations[0].GetUniswapV3().GetFeePips() != 3000 {
		t.Fatal("direct candidates are not in canonical fee order")
	}
}

func TestAtomicPlanQuoteBalancerUsesExecutorSenderAndCanonicalPoolOrder(t *testing.T) {
	pool1 := common.HexToHash("0x1111111111111111111111111111111111111111000000000000000000000001")
	pool2 := common.HexToHash("0x2222222222222222222222222222222222222222000000000000000000000002")
	vault, executor := common.HexToAddress("0x3333333333333333333333333333333333333333"), common.HexToAddress("0x4444444444444444444444444444444444444444")
	cfg := atomicQuoteConfig(common.HexToAddress("0x55"))
	cfg.Deployments = map[string]config.Deployment{"bal": {Kind: "balancer-v2", ProviderConfig: balancer.Options{Vault: vault.Hex(), Pools: []string{pool1.Hex(), pool2.Hex()}}}}
	cfg.AtomicExecutor = &config.AtomicExecutor{Address: executor.Hex(), RuntimeCodeHash: common.HexToHash("0x11").Hex(), BalancerDeployment: "bal"}
	reader := readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil }, call: func(_ context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
		if to != vault {
			return nil, errors.New("wrong target")
		}
		if bytes.Equal(data[:4], balancerVaultABI.Methods["getPoolTokens"].ID) {
			return balancerTokensResult(t, testWETH.Hex(), common.HexToAddress("0x5555555555555555555555555555555555555555").Hex(), testUSDC.Hex()), nil
		}
		values, err := balancerVaultABI.Methods["queryBatchSwap"].Inputs.Unpack(data[4:])
		if err != nil {
			t.Fatal(err)
		}
		funds := values[3].(struct {
			Sender              common.Address `json:"sender"`
			FromInternalBalance bool           `json:"fromInternalBalance"`
			Recipient           common.Address `json:"recipient"`
			ToInternalBalance   bool           `json:"toInternalBalance"`
		})
		if funds.Sender != executor || funds.Recipient != executor || funds.Sender == balancerQuerySender {
			t.Fatal("Atomic quote did not use executor as Balancer sender")
		}
		steps := values[1].([]struct {
			PoolId        [32]byte `json:"poolId"`
			AssetInIndex  *big.Int `json:"assetInIndex"`
			AssetOutIndex *big.Int `json:"assetOutIndex"`
			Amount        *big.Int `json:"amount"`
			UserData      []uint8  `json:"userData"`
		})
		if common.Hash(steps[0].PoolId) == pool1 {
			time.Sleep(3 * time.Millisecond)
		}
		return balancerVaultABI.Methods["queryBatchSwap"].Outputs.Pack([]*big.Int{big.NewInt(37), big.NewInt(-31)})
	}}
	response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: cfg}}, QuoteConcurrency: 2}).GetPlanQuote(t.Context(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	if err != nil || len(response.Msg.Candidates) != 2 {
		t.Fatalf("Balancer quote failed: %+v %v", response, err)
	}
	for i, want := range []common.Hash{pool1, pool2} {
		pool := response.Msg.Candidates[i].Program.Branches[0].Operations[0].GetBalancerV2()
		if pool == nil || common.BytesToHash(pool.PoolId) != want || response.Msg.Candidates[i].NetworkCostOut != nil {
			t.Fatal("Balancer candidates escaped canonical order")
		}
	}
}

func TestAtomicPlanQuoteReturnsCanonicalDirectUniswapV4Candidates(t *testing.T) {
	stateView := common.HexToAddress("0x5555555555555555555555555555555555555555")
	quoter := common.HexToAddress("0x6666666666666666666666666666666666666666")
	manager := common.HexToAddress("0x7777777777777777777777777777777777777777")
	pools := []uniswapv4.Pool{
		{Currency0: testWETH.Hex(), Currency1: testUSDC.Hex(), FeePips: 3000, TickSpacing: 60, Hooks: common.Address{}.Hex()},
		{Currency0: testWETH.Hex(), Currency1: testUSDC.Hex(), FeePips: 500, TickSpacing: 10, Hooks: common.Address{}.Hex()},
	}
	cfg := atomicQuoteConfig(common.HexToAddress("0x2222222222222222222222222222222222222222"))
	cfg.Deployments = map[string]config.Deployment{"v4": {Kind: "uniswap-v4", Quoter: quoter.Hex(), Router: common.HexToAddress("0x8888888888888888888888888888888888888888").Hex(), ProviderConfig: uniswapv4.Options{PoolManager: manager.Hex(), StateView: stateView.Hex(), Pools: pools}}}
	cfg.AtomicExecutor = &config.AtomicExecutor{Address: common.HexToAddress("0x9999999999999999999999999999999999999999").Hex(), RuntimeCodeHash: common.HexToHash("0x11").Hex(), UniswapV4Deployment: "v4"}
	reader := readerFake{snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil }, call: func(_ context.Context, to common.Address, data []byte, hash common.Hash) ([]byte, error) {
		if hash != common.HexToHash(snapshot().BlockHash) {
			t.Fatal("V4 quote escaped pinned block")
		}
		if to == stateView {
			return contractabi.UniswapV4StateView.Methods["getSlot0"].Outputs.Pack(big.NewInt(1), big.NewInt(0), big.NewInt(0), big.NewInt(0))
		}
		if to != quoter {
			return nil, errors.New("unexpected V4 target")
		}
		values, err := contractabi.UniswapV4Quoter.Methods["quoteExactInputSingle"].Inputs.Unpack(data[4:])
		if err != nil {
			t.Fatal(err)
		}
		params := values[0].(struct {
			PoolKey struct {
				Currency0   common.Address `json:"currency0"`
				Currency1   common.Address `json:"currency1"`
				Fee         *big.Int       `json:"fee"`
				TickSpacing *big.Int       `json:"tickSpacing"`
				Hooks       common.Address `json:"hooks"`
			} `json:"poolKey"`
			ZeroForOne  bool     `json:"zeroForOne"`
			ExactAmount *big.Int `json:"exactAmount"`
			HookData    []byte   `json:"hookData"`
		})
		if params.PoolKey.Fee.Uint64() == 500 {
			time.Sleep(3 * time.Millisecond)
		}
		return contractabi.UniswapV4Quoter.Methods["quoteExactInputSingle"].Outputs.Pack(new(big.Int).Add(params.ExactAmount, params.PoolKey.Fee), big.NewInt(1))
	}}
	response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: cfg}}, QuoteConcurrency: 2}).GetPlanQuote(t.Context(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	if err != nil || len(response.Msg.Candidates) != 2 {
		t.Fatalf("unexpected V4 candidates: %+v %v", response, err)
	}
	want := append([]uniswapv4.Pool(nil), pools...)
	sort.Slice(want, func(i, j int) bool {
		left, _ := uniswapv4.PoolID(v4PoolKey(want[i]))
		right, _ := uniswapv4.PoolID(v4PoolKey(want[j]))
		return left.Hex() < right.Hex()
	})
	for i, candidate := range response.Msg.Candidates {
		operation := candidate.Program.Branches[0].Operations[0]
		pool := operation.GetUniswapV4()
		if pool == nil || len(candidate.Program.Branches[0].Operations) != 1 || pool.GetKey().GetFeePips() != want[i].FeePips || len(candidate.BranchQuotes[0].OperationOutputs) != 1 || candidate.NetworkCostOut != nil {
			t.Fatalf("V4 candidate %d escaped canonical direct policy", i)
		}
	}
}

func TestAtomicPlanQuoteKeepsCanonicalCrossProviderOrder(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	cfg := atomicQuoteConfig(middle)
	cakeFactory := common.HexToAddress("0x7777777777777777777777777777777777777777")
	cakeQuoter := common.HexToAddress("0x8888888888888888888888888888888888888888")
	cfg.Deployments["cake"] = config.Deployment{Kind: "pancake-v3", Factory: cakeFactory.Hex(), Quoter: cakeQuoter.Hex(), Router: common.HexToAddress("0x9999").Hex(), Fees: []uint32{2500}}
	uniswap := cfg.Deployments["uni"]
	uniswap.Fees = []uint32{500}
	cfg.Deployments["uni"] = uniswap
	cfg.AtomicExecutor.PancakeDeployment = "cake"
	reader := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(_ context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
			if to == testFactory || to == cakeFactory {
				return poolResponse(common.BytesToAddress(crypto.Keccak256(data)[12:])), nil
			}
			if to == cakeQuoter {
				time.Sleep(3 * time.Millisecond)
			}
			input := new(big.Int).SetBytes(data[68:100]).Uint64()
			return quoteResponse(input + uint64(calldataFee(data))), nil
		},
	}
	response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: cfg}}, QuoteConcurrency: 4}).GetPlanQuote(context.Background(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	if err != nil || len(response.Msg.Candidates) != 4 {
		t.Fatalf("unexpected candidates: %+v %v", response, err)
	}
	for i, candidate := range response.Msg.Candidates {
		operation := candidate.Program.Branches[0].Operations[0]
		if i < 2 && operation.GetPancakeV3() == nil || i >= 2 && operation.GetUniswapV3() == nil {
			t.Fatalf("candidate %d escaped configured deployment order", i)
		}
		if i%2 == 0 && len(candidate.Program.Branches[0].Operations) != 1 || i%2 == 1 && len(candidate.Program.Branches[0].Operations) != 2 {
			t.Fatalf("candidate %d escaped canonical path order", i)
		}
	}
}

func TestAtomicPlanQuoteReturnsCanonicalHomogeneousSlipstreamCandidates(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	factory := common.HexToAddress("0x7777777777777777777777777777777777777777")
	quoter := common.HexToAddress("0x8888888888888888888888888888888888888888")
	module := common.HexToAddress("0x9999999999999999999999999999999999999999")
	cfg := atomicQuoteConfig(middle)
	cfg.Deployments = map[string]config.Deployment{"slip": {
		Kind: "aerodrome-slipstream", Factory: factory.Hex(), Quoter: quoter.Hex(), Router: common.HexToAddress("0xaaaa").Hex(),
		ProviderConfig: slipstream.Options{TickSpacings: []int32{200, 100}},
	}}
	cfg.AtomicExecutor.UniswapDeployment = ""
	cfg.AtomicExecutor.SlipstreamDeployment = "slip"
	var originChecks atomic.Int32
	reader := readerFake{
		snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
		call: func(_ context.Context, to common.Address, data []byte, _ common.Hash) ([]byte, error) {
			signature := func(method []byte) bool { return bytes.Equal(data[:4], method) }
			if to == factory && signature(contractabi.AerodromeSlipstreamFactory.Methods["swapFeeModule"].ID) {
				originChecks.Add(1)
				return poolResponse(module), nil
			}
			if to == module && signature(contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["discounted"].ID) {
				return uintWord(0), nil
			}
			if to == factory {
				return poolResponse(common.BytesToAddress(crypto.Keccak256(data)[12:])), nil
			}
			if to == quoter {
				input := new(big.Int).SetBytes(data[68:100]).Uint64()
				spacing := new(big.Int).SetBytes(data[100:132]).Uint64()
				if spacing == 200 {
					time.Sleep(3 * time.Millisecond)
				}
				return quoteResponse(input + spacing), nil
			}
			return nil, errors.New("unexpected Atomic Slipstream quote call")
		},
	}
	response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: cfg}}, QuoteConcurrency: 4}).GetPlanQuote(context.Background(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	if err != nil || len(response.Msg.Candidates) != 6 || originChecks.Load() != 1 {
		t.Fatalf("unexpected Slipstream candidates: %+v checks=%d error=%v", response, originChecks.Load(), err)
	}
	want := [][]int32{{100}, {200}, {100, 100}, {100, 200}, {200, 100}, {200, 200}}
	for i, value := range response.Msg.Candidates {
		operations := value.Program.Branches[0].Operations
		if len(operations) != len(want[i]) || len(value.BranchQuotes[0].OperationOutputs) != len(want[i]) {
			t.Fatalf("candidate %d has wrong cardinality", i)
		}
		for j, spacing := range want[i] {
			pool := operations[j].GetSlipstreamInitial()
			if pool == nil || pool.GetTickSpacing() != spacing || new(big.Int).SetBytes(value.BranchQuotes[0].OperationOutputs[j]).Sign() <= 0 {
				t.Fatalf("candidate %d operation %d escaped canonical Slipstream order", i, j)
			}
		}
	}
}

func TestAtomicPlanQuoteRejectsMalformedAndAmbiguousRequests(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	chain := Chain{ChainID: "8453", Client: readerFake{}, Config: atomicQuoteConfig(middle)}
	handler := Handler{Chains: map[string]Chain{"a": chain}, QuoteConcurrency: 1}
	tests := []struct {
		name string
		edit func(*atomicv1.PlanQuoteRequest)
	}{
		{"missing version", func(r *atomicv1.PlanQuoteRequest) { r.FormatVersion = nil }},
		{"unknown version", func(r *atomicv1.PlanQuoteRequest) { r.FormatVersion = proto.Uint32(2) }},
		{"empty chain", func(r *atomicv1.PlanQuoteRequest) { r.ChainId = nil }},
		{"zero chain", func(r *atomicv1.PlanQuoteRequest) { r.ChainId = make([]byte, 32) }},
		{"short token", func(r *atomicv1.PlanQuoteRequest) { r.TokenIn = make([]byte, 19) }},
		{"equal token", func(r *atomicv1.PlanQuoteRequest) { r.TokenOut = append([]byte(nil), r.TokenIn...) }},
		{"zero amount", func(r *atomicv1.PlanQuoteRequest) { r.AmountIn = make([]byte, 32) }},
		{"missing budget", func(r *atomicv1.PlanQuoteRequest) { r.SearchBudgetMs = nil }},
		{"zero budget", func(r *atomicv1.PlanQuoteRequest) { r.SearchBudgetMs = proto.Uint32(0) }},
		{"unknown field", func(r *atomicv1.PlanQuoteRequest) { r.ProtoReflect().SetUnknown([]byte{0x38, 0x01}) }},
		{"unknown chain", func(r *atomicv1.PlanQuoteRequest) { r.ChainId = uint256Bytes(big.NewInt(1)) }},
		{"unconfigured token", func(r *atomicv1.PlanQuoteRequest) { r.TokenIn = common.HexToAddress("0x9999").Bytes() }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := atomicQuoteRequest("8453", testWETH, testUSDC, "37")
			test.edit(request)
			_, err := handler.GetPlanQuote(context.Background(), connect.NewRequest(request))
			var connectErr *connect.Error
			if !errors.As(err, &connectErr) || connectErr.Code() != connect.CodeInvalidArgument {
				t.Fatalf("got %v", err)
			}
		})
	}
	handler.Chains["b"] = chain
	_, err := handler.GetPlanQuote(context.Background(), connect.NewRequest(atomicQuoteRequest("8453", testWETH, testUSDC, "37")))
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) || connectErr.Code() != connect.CodeInvalidArgument {
		t.Fatalf("ambiguous chain got %v", err)
	}
}

func TestAtomicPlanQuoteAllowsEmptyAndPartialResults(t *testing.T) {
	middle := common.HexToAddress("0x2222222222222222222222222222222222222222")
	config := atomicQuoteConfig(middle)
	for _, partial := range []bool{false, true} {
		reader := readerFake{
			snapshot: func(context.Context) (rpc.Snapshot, error) { return snapshot(), nil },
			call: func(ctx context.Context, _ common.Address, _ []byte, _ common.Hash) ([]byte, error) {
				if partial {
					<-ctx.Done()
					return nil, ctx.Err()
				}
				return make([]byte, 32), nil
			},
		}
		request := atomicQuoteRequest("8453", testWETH, testUSDC, "37")
		if partial {
			request.SearchBudgetMs = proto.Uint32(1)
		}
		response, err := (Handler{Chains: map[string]Chain{"base": {ChainID: "8453", Client: reader, Config: config}}, QuoteConcurrency: 2}).GetPlanQuote(context.Background(), connect.NewRequest(request))
		if err != nil || len(response.Msg.Candidates) != 0 || response.Msg.SearchComplete == nil || response.Msg.GetSearchComplete() == partial {
			t.Fatalf("partial=%t response=%+v error=%v", partial, response, err)
		}
	}
}
