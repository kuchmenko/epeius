package quote

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	"github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1/atomicv1connect"
	"google.golang.org/protobuf/proto"
)

func feeTransportRequest(nonce byte) *atomicv1.EvaluatePlanFeesRequest {
	chainID := uint256Bytes(bigInt(1))
	signer := bytes.Repeat([]byte{0x11}, 20)
	blockNumber := uint256Bytes(bigInt(100))
	blockHash := bytes.Repeat([]byte{0x22}, 32)
	timestamp := uint256Bytes(bigInt(1_700_000_000))
	balance := uint256Bytes(bigInt(1_000_000))
	setupHash := bytes.Repeat([]byte{0x33}, 32)
	setup := []*atomicv1.SetupStateEntry{
		{Kind: proto.Uint32(1), Token: bytes.Repeat([]byte{0x44}, 20), Owner: signer, Spender: bytes.Repeat([]byte{0x55}, 20), Value: uint256Bytes(bigInt(7))},
		{Kind: proto.Uint32(1), Token: bytes.Repeat([]byte{0x66}, 20), Owner: signer, Spender: bytes.Repeat([]byte{0x77}, 20), Value: uint256Bytes(bigInt(8))},
	}
	pendingNonce := uint256Bytes(bigInt(int64(nonce)))
	envelope := &atomicv1.UnsignedType2EnvelopeProposal{
		TransactionType:      proto.Uint32(2),
		ChainId:              chainID,
		Nonce:                pendingNonce,
		Sender:               signer,
		Target:               bytes.Repeat([]byte{0x11}, 20),
		Value:                make([]byte, 32),
		Calldata:             []byte{0x12, 0x34},
		GasLimit:             uint256Bytes(bigInt(21_000)),
		MaxPriorityFeePerGas: uint256Bytes(bigInt(1)),
		MaxFeePerGas:         uint256Bytes(bigInt(128)),
		AccessListRlp:        []byte{0xc0},
	}
	envelope.Serialized = unsignedType2Bytes(envelope)
	return &atomicv1.EvaluatePlanFeesRequest{
		FormatVersion: proto.Uint32(1),
		QuoteId:       bytes.Repeat([]byte{0x99}, 32),
		FeeSnapshot: &atomicv1.FeeExecutionSnapshotProposal{
			ChainId: chainID, Signer: signer, QuoteBlock: &atomicv1.PinnedBlock{Number: blockNumber, Hash: blockHash},
			QuoteBlockTimestamp: append([]byte(nil), timestamp...), ObservedAtUnix: uint256Bytes(bigInt(1_700_000_001)), HistoricalNonceAtBlock: uint256Bytes(bigInt(126)),
			HistoricalNativeBalanceAtBlock: balance, SetupStateAtBlock: setup, SetupStateAtBlockSha256: setupHash, ForecastTargetBlockNumber: uint256Bytes(bigInt(101)),
		},
		AccountSnapshot: &atomicv1.AccountSnapshotProposal{
			ChainId: append([]byte(nil), chainID...), Signer: append([]byte(nil), signer...), AccountBlock: &atomicv1.PinnedBlock{Number: append([]byte(nil), blockNumber...), Hash: append([]byte(nil), blockHash...)}, AccountBlockTimestamp: append([]byte(nil), timestamp...),
			ObservedAtUnix: uint256Bytes(bigInt(1_700_000_002)), NativeBalanceAtBlock: balance, SetupStateAtBlock: proto.CloneOf(&atomicv1.FeeExecutionSnapshotProposal{SetupStateAtBlock: setup}).SetupStateAtBlock, SetupStateAtBlockSha256: setupHash,
		},
		PendingAccount: &atomicv1.PendingAccountProposal{
			ChainId: append([]byte(nil), chainID...), Signer: append([]byte(nil), signer...), PendingNonce: append([]byte(nil), pendingNonce...), ObservedAtUnix: uint256Bytes(bigInt(1_700_000_003)), MethodProfile: proto.String("eth_getTransactionCount-pending-v1"), TerminalPendingReservations: make([]byte, 32), BlockContext: proto.String("none"),
		},
		Candidates: []*atomicv1.FeeCandidateProposal{{
			CandidateId: bytes.Repeat([]byte{1}, 32), PlanId: bytes.Repeat([]byte{2}, 32), PreparationId: bytes.Repeat([]byte{3}, 32), ExecutorPlanHash: bytes.Repeat([]byte{4}, 32), TransactionFingerprint: bytes.Repeat([]byte{5}, 32), Envelope: envelope,
		}},
		PolicyConfigSha256: bytes.Repeat([]byte{0xaa}, 32),
	}
}

func bigInt(value int64) *big.Int { return big.NewInt(value) }

func TestEvaluatePlanFeesValidatesThenReturnsUnimplemented(t *testing.T) {
	request127 := feeTransportRequest(127)
	request128 := feeTransportRequest(128)
	if got := request127.Candidates[0].Envelope.Serialized; !bytes.Equal(got, mustHex(t, "02e2017f01818082520894111111111111111111111111111111111111111180821234c0")) {
		t.Fatalf("nonce 127 serialization = %x", got)
	}
	if got := request128.Candidates[0].Envelope.Serialized; !bytes.Equal(got, mustHex(t, "02e301818001818082520894111111111111111111111111111111111111111180821234c0")) {
		t.Fatalf("nonce 128 serialization = %x", got)
	}
	for _, request := range []*atomicv1.EvaluatePlanFeesRequest{request127, request128} {
		response, err := (Handler{}).EvaluatePlanFees(t.Context(), connect.NewRequest(request))
		if response != nil || connect.CodeOf(err) != connect.CodeUnimplemented || err.Error() != "unimplemented: "+feeTransportUnavailable {
			t.Fatalf("valid request result = %#v, %v", response, err)
		}
	}
}

func TestEvaluatePlanFeesPreservesCandidateOrder(t *testing.T) {
	request := feeTransportRequest(127)
	addFeeCandidate(request)
	wire, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(atomicv1.EvaluatePlanFeesRequest)
	if err := proto.Unmarshal(wire, decoded); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded.Candidates[0].CandidateId, request.Candidates[0].CandidateId) || !bytes.Equal(decoded.Candidates[1].CandidateId, request.Candidates[1].CandidateId) {
		t.Fatal("candidate order changed across protobuf transport")
	}
	if response, err := (Handler{}).EvaluatePlanFees(t.Context(), connect.NewRequest(decoded)); response != nil || connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("ordered request result = %#v, %v", response, err)
	}
}

func TestEvaluatePlanFeesGeneratedTransport(t *testing.T) {
	path, service := atomicv1connect.NewAtomicPlanServiceHandler(Handler{})
	mux := http.NewServeMux()
	mux.Handle(path, service)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := atomicv1connect.NewAtomicPlanServiceClient(server.Client(), server.URL)

	if response, err := client.EvaluatePlanFees(t.Context(), connect.NewRequest(feeTransportRequest(127))); response != nil || connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("valid transport result = %#v, %v", response, err)
	}
	stale := feeTransportRequest(127)
	stale.AccountSnapshot.AccountBlock.Number = uint256Bytes(bigInt(101))
	stale.AccountSnapshot.AccountBlock.Hash[0]++
	response, err := client.EvaluatePlanFees(t.Context(), connect.NewRequest(stale))
	if err != nil || response.Msg.GetStatus() != atomicv1.FeeEvidenceStatus_FEE_EVIDENCE_STATUS_STALE {
		t.Fatalf("stale transport result = %#v, %v", response, err)
	}
}

func TestEvaluatePlanFeesRejectsMalformedRequestBeforeImplementation(t *testing.T) {
	mutations := map[string]func(*atomicv1.EvaluatePlanFeesRequest){
		"unknown root field": func(v *atomicv1.EvaluatePlanFeesRequest) { v.ProtoReflect().SetUnknown([]byte{0x40, 1}) },
		"unknown nested field": func(v *atomicv1.EvaluatePlanFeesRequest) {
			v.Candidates[0].Envelope.ProtoReflect().SetUnknown([]byte{0x68, 1})
		},
		"absent format":               func(v *atomicv1.EvaluatePlanFeesRequest) { v.FormatVersion = nil },
		"wrong format":                func(v *atomicv1.EvaluatePlanFeesRequest) { *v.FormatVersion = 2 },
		"empty quote ID":              func(v *atomicv1.EvaluatePlanFeesRequest) { v.QuoteId = []byte{} },
		"absent snapshot":             func(v *atomicv1.EvaluatePlanFeesRequest) { v.FeeSnapshot = nil },
		"zero chain":                  func(v *atomicv1.EvaluatePlanFeesRequest) { v.FeeSnapshot.ChainId = make([]byte, 32) },
		"short hash":                  func(v *atomicv1.EvaluatePlanFeesRequest) { v.AccountSnapshot.AccountBlock.Hash = make([]byte, 31) },
		"zero signer":                 func(v *atomicv1.EvaluatePlanFeesRequest) { v.PendingAccount.Signer = make([]byte, 20) },
		"absent method profile":       func(v *atomicv1.EvaluatePlanFeesRequest) { v.PendingAccount.MethodProfile = nil },
		"empty method profile":        func(v *atomicv1.EvaluatePlanFeesRequest) { v.PendingAccount.MethodProfile = proto.String("") },
		"pending attributed to block": func(v *atomicv1.EvaluatePlanFeesRequest) { v.PendingAccount.BlockContext = proto.String("b") },
		"B plus one overflow": func(v *atomicv1.EvaluatePlanFeesRequest) {
			v.FeeSnapshot.QuoteBlock.Number = bytes.Repeat([]byte{0xff}, 32)
		},
		"wrong forecast target": func(v *atomicv1.EvaluatePlanFeesRequest) { v.FeeSnapshot.ForecastTargetBlockNumber[31]++ },
		"C below B": func(v *atomicv1.EvaluatePlanFeesRequest) {
			v.AccountSnapshot.AccountBlock.Number = uint256Bytes(bigInt(99))
		},
		"different timestamp":  func(v *atomicv1.EvaluatePlanFeesRequest) { v.AccountSnapshot.AccountBlockTimestamp[31]++ },
		"different balance":    func(v *atomicv1.EvaluatePlanFeesRequest) { v.AccountSnapshot.NativeBalanceAtBlock[31]++ },
		"different setup hash": func(v *atomicv1.EvaluatePlanFeesRequest) { v.AccountSnapshot.SetupStateAtBlockSha256[31]++ },
		"unsorted setup": func(v *atomicv1.EvaluatePlanFeesRequest) {
			v.FeeSnapshot.SetupStateAtBlock[0], v.FeeSnapshot.SetupStateAtBlock[1] = v.FeeSnapshot.SetupStateAtBlock[1], v.FeeSnapshot.SetupStateAtBlock[0]
		},
		"duplicate setup": func(v *atomicv1.EvaluatePlanFeesRequest) {
			v.AccountSnapshot.SetupStateAtBlock[1] = proto.CloneOf(v.AccountSnapshot.SetupStateAtBlock[0])
		},
		"setup wrong owner":          func(v *atomicv1.EvaluatePlanFeesRequest) { v.FeeSnapshot.SetupStateAtBlock[0].Owner[0]++ },
		"setup unknown kind":         func(v *atomicv1.EvaluatePlanFeesRequest) { *v.FeeSnapshot.SetupStateAtBlock[0].Kind = 2 },
		"absent setup hash":          func(v *atomicv1.EvaluatePlanFeesRequest) { v.FeeSnapshot.SetupStateAtBlockSha256 = nil },
		"absent candidates":          func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates = nil },
		"wrong transaction type":     func(v *atomicv1.EvaluatePlanFeesRequest) { *v.Candidates[0].Envelope.TransactionType = 3 },
		"nonce differs from pending": func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.Nonce[31]++ },
		"wrong envelope chain":       func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.ChainId[31]++ },
		"wrong envelope signer":      func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.Sender[0]++ },
		"zero target":                func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.Target = make([]byte, 20) },
		"absent calldata":            func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.Calldata = nil },
		"empty calldata":             func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.Calldata = []byte{} },
		"zero gas":                   func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.GasLimit = make([]byte, 32) },
		"zero max fee":               func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.MaxFeePerGas = make([]byte, 32) },
		"priority above max": func(v *atomicv1.EvaluatePlanFeesRequest) {
			v.Candidates[0].Envelope.MaxPriorityFeePerGas = uint256Bytes(bigInt(129))
		},
		"absent access list":       func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.AccessListRlp = nil },
		"nonempty access list":     func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.AccessListRlp = []byte{0xc1, 0xc0} },
		"malformed serialized":     func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].Envelope.Serialized[0] = 3 },
		"short candidate identity": func(v *atomicv1.EvaluatePlanFeesRequest) { v.Candidates[0].PlanId = make([]byte, 31) },
		"duplicate candidate identity": func(v *atomicv1.EvaluatePlanFeesRequest) {
			addFeeCandidate(v)
			v.Candidates[1].CandidateId = append([]byte(nil), v.Candidates[0].CandidateId...)
		},
		"duplicate plan identity": func(v *atomicv1.EvaluatePlanFeesRequest) {
			addFeeCandidate(v)
			v.Candidates[1].PlanId = append([]byte(nil), v.Candidates[0].PlanId...)
		},
		"duplicate preparation identity": func(v *atomicv1.EvaluatePlanFeesRequest) {
			addFeeCandidate(v)
			v.Candidates[1].PreparationId = append([]byte(nil), v.Candidates[0].PreparationId...)
		},
		"duplicate executor-plan identity": func(v *atomicv1.EvaluatePlanFeesRequest) {
			addFeeCandidate(v)
			v.Candidates[1].ExecutorPlanHash = append([]byte(nil), v.Candidates[0].ExecutorPlanHash...)
		},
		"duplicate fingerprint": func(v *atomicv1.EvaluatePlanFeesRequest) {
			addFeeCandidate(v)
			v.Candidates[1].TransactionFingerprint = append([]byte(nil), v.Candidates[0].TransactionFingerprint...)
		},
		"different candidate caps": func(v *atomicv1.EvaluatePlanFeesRequest) {
			addFeeCandidate(v)
			v.Candidates[1].Envelope.MaxFeePerGas[31]++
			v.Candidates[1].Envelope.Serialized = unsignedType2Bytes(v.Candidates[1].Envelope)
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			request := proto.CloneOf(feeTransportRequest(127))
			mutate(request)
			if response, err := (Handler{}).EvaluatePlanFees(t.Context(), connect.NewRequest(request)); response != nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("result = %#v, %v", response, err)
			}
		})
	}
}

func TestEvaluatePlanFeesRepresentsSelfEvidentStaleSnapshotsWithoutEvidence(t *testing.T) {
	mutations := map[string]func(*atomicv1.EvaluatePlanFeesRequest){
		"C reaches B plus one": func(v *atomicv1.EvaluatePlanFeesRequest) {
			v.AccountSnapshot.AccountBlock.Number = uint256Bytes(bigInt(101))
			v.AccountSnapshot.AccountBlock.Hash[0]++
		},
		"same height different hash": func(v *atomicv1.EvaluatePlanFeesRequest) { v.AccountSnapshot.AccountBlock.Hash[0]++ },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			request := feeTransportRequest(127)
			mutate(request)
			response, err := (Handler{}).EvaluatePlanFees(t.Context(), connect.NewRequest(request))
			if err != nil || response.Msg.GetStatus() != atomicv1.FeeEvidenceStatus_FEE_EVIDENCE_STATUS_STALE || response.Msg.FeeEvidenceId != nil || response.Msg.CanonicalEvidenceJson != nil || response.Msg.GetMessage() == "" {
				t.Fatalf("stale result = %#v, %v", response, err)
			}
		})
	}
}

func addFeeCandidate(request *atomicv1.EvaluatePlanFeesRequest) {
	candidate := proto.CloneOf(request.Candidates[0])
	for _, identity := range [][]byte{candidate.CandidateId, candidate.PlanId, candidate.PreparationId, candidate.ExecutorPlanHash, candidate.TransactionFingerprint} {
		identity[0]++
	}
	request.Candidates = append(request.Candidates, candidate)
}

func mustHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
