package quote

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"slices"

	"connectrpc.com/connect"
	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	"google.golang.org/protobuf/proto"
)

const feeTransportUnavailable = "fee evidence evaluation is not implemented"

func (h Handler) EvaluatePlanFees(_ context.Context, request *connect.Request[atomicv1.EvaluatePlanFeesRequest]) (*connect.Response[atomicv1.EvaluatePlanFeesResponse], error) {
	if request == nil || request.Msg == nil {
		return nil, invalidFeeRequest()
	}
	if err := h.checkAtomicRequest(request.Msg); err != nil {
		return nil, err
	}
	stale, err := validateFeeTransportRequest(request.Msg)
	if err != nil {
		return nil, invalidFeeRequest()
	}
	if stale {
		status := atomicv1.FeeEvidenceStatus_FEE_EVIDENCE_STATUS_STALE
		response := &atomicv1.EvaluatePlanFeesResponse{
			FormatVersion: proto.Uint32(1),
			Status:        &status,
			Message:       proto.String("fee snapshots are stale; request a fresh quote"),
		}
		if err := h.checkAtomicResponse(response); err != nil {
			return nil, err
		}
		return connect.NewResponse(response), nil
	}
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New(feeTransportUnavailable))
}

func invalidFeeRequest() error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New("invalid fee evidence request"))
}

func validateFeeTransportRequest(request *atomicv1.EvaluatePlanFeesRequest) (bool, error) {
	if hasUnknown(request.ProtoReflect()) || request.FormatVersion == nil || request.GetFormatVersion() != 1 || len(request.QuoteId) != 32 || request.FeeSnapshot == nil || request.AccountSnapshot == nil || request.PendingAccount == nil || len(request.Candidates) == 0 || len(request.PolicyConfigSha256) != 32 {
		return false, errors.New("incomplete request")
	}
	fee, account, pending := request.FeeSnapshot, request.AccountSnapshot, request.PendingAccount
	if !validFeeSnapshot(fee) || !validAccountSnapshot(account) || !validPendingAccount(pending) {
		return false, errors.New("invalid snapshots")
	}
	if !bytes.Equal(fee.ChainId, account.ChainId) || !bytes.Equal(fee.ChainId, pending.ChainId) || !bytes.Equal(fee.Signer, account.Signer) || !bytes.Equal(fee.Signer, pending.Signer) {
		return false, errors.New("snapshot identity mismatch")
	}
	if err := validateFeeCandidates(request.Candidates, fee.ChainId, fee.Signer, pending.PendingNonce); err != nil {
		return false, err
	}
	b := new(big.Int).SetBytes(fee.QuoteBlock.Number)
	target := new(big.Int).Add(new(big.Int).Set(b), big.NewInt(1))
	if target.BitLen() > 256 || !bytes.Equal(uint256Bytes(target), fee.ForecastTargetBlockNumber) {
		return false, errors.New("invalid forecast target")
	}
	c := new(big.Int).SetBytes(account.AccountBlock.Number)
	if c.Cmp(b) < 0 {
		return false, errors.New("account block precedes quote block")
	}
	if c.Cmp(b) > 0 || !bytes.Equal(fee.QuoteBlock.Hash, account.AccountBlock.Hash) {
		return true, nil
	}
	if !bytes.Equal(fee.QuoteBlockTimestamp, account.AccountBlockTimestamp) || !bytes.Equal(fee.HistoricalNativeBalanceAtBlock, account.NativeBalanceAtBlock) || !bytes.Equal(fee.SetupStateAtBlockSha256, account.SetupStateAtBlockSha256) || !setupStatesEqual(fee.SetupStateAtBlock, account.SetupStateAtBlock) {
		return false, errors.New("same-block state mismatch")
	}
	return false, nil
}

func validFeeSnapshot(value *atomicv1.FeeExecutionSnapshotProposal) bool {
	return value != nil && len(value.ChainId) == 32 && !allZero(value.ChainId) && validNonzeroAddress(value.Signer) && validPinnedBlock(value.QuoteBlock) && len(value.QuoteBlockTimestamp) == 32 && len(value.ObservedAtUnix) == 32 && len(value.HistoricalNonceAtBlock) == 32 && len(value.HistoricalNativeBalanceAtBlock) == 32 && validSetupState(value.SetupStateAtBlock, value.Signer) && len(value.SetupStateAtBlockSha256) == 32 && len(value.ForecastTargetBlockNumber) == 32
}

func validAccountSnapshot(value *atomicv1.AccountSnapshotProposal) bool {
	return value != nil && len(value.ChainId) == 32 && !allZero(value.ChainId) && validNonzeroAddress(value.Signer) && validPinnedBlock(value.AccountBlock) && len(value.AccountBlockTimestamp) == 32 && len(value.ObservedAtUnix) == 32 && len(value.NativeBalanceAtBlock) == 32 && validSetupState(value.SetupStateAtBlock, value.Signer) && len(value.SetupStateAtBlockSha256) == 32
}

func validPendingAccount(value *atomicv1.PendingAccountProposal) bool {
	return value != nil && len(value.ChainId) == 32 && !allZero(value.ChainId) && validNonzeroAddress(value.Signer) && len(value.PendingNonce) == 32 && len(value.ObservedAtUnix) == 32 && value.MethodProfile != nil && value.GetMethodProfile() != "" && len(value.TerminalPendingReservations) == 32 && value.BlockContext != nil && value.GetBlockContext() == "none"
}

func validPinnedBlock(value *atomicv1.PinnedBlock) bool {
	return value != nil && len(value.Number) == 32 && len(value.Hash) == 32 && !allZero(value.Hash)
}

func validNonzeroAddress(value []byte) bool {
	return len(value) == 20 && !allZero(value)
}

func allZero(value []byte) bool {
	return bytes.Equal(value, make([]byte, len(value)))
}

func validSetupState(entries []*atomicv1.SetupStateEntry, signer []byte) bool {
	var previous []byte
	for _, entry := range entries {
		if entry == nil || entry.Kind == nil || entry.GetKind() != 1 || !validNonzeroAddress(entry.Token) || !bytes.Equal(entry.Owner, signer) || !validNonzeroAddress(entry.Spender) || len(entry.Value) != 32 {
			return false
		}
		key := setupStateKey(entry)
		if previous != nil && bytes.Compare(previous, key) >= 0 {
			return false
		}
		previous = key
	}
	return true
}

func setupStateKey(entry *atomicv1.SetupStateEntry) []byte {
	key := []byte{byte(entry.GetKind() >> 24), byte(entry.GetKind() >> 16), byte(entry.GetKind() >> 8), byte(entry.GetKind())}
	return slices.Concat(key, entry.Token, entry.Owner, entry.Spender)
}

func setupStatesEqual(left, right []*atomicv1.SetupStateEntry) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if !proto.Equal(left[i], right[i]) {
			return false
		}
	}
	return true
}

func validateFeeCandidates(candidates []*atomicv1.FeeCandidateProposal, chainID, signer, pendingNonce []byte) error {
	seen := [5]map[string]bool{{}, {}, {}, {}, {}}
	var commonPriority, commonMaximum []byte
	for index, candidate := range candidates {
		if candidate == nil || candidate.Envelope == nil {
			return errors.New("missing candidate")
		}
		identities := [][]byte{candidate.CandidateId, candidate.PlanId, candidate.PreparationId, candidate.ExecutorPlanHash, candidate.TransactionFingerprint}
		for i, identity := range identities {
			if len(identity) != 32 || seen[i][string(identity)] {
				return errors.New("invalid candidate identity")
			}
			seen[i][string(identity)] = true
		}
		envelope := candidate.Envelope
		if !validUnsignedEnvelope(envelope, chainID, signer, pendingNonce) {
			return errors.New("invalid unsigned envelope")
		}
		if index == 0 {
			commonPriority, commonMaximum = envelope.MaxPriorityFeePerGas, envelope.MaxFeePerGas
		} else if !bytes.Equal(commonPriority, envelope.MaxPriorityFeePerGas) || !bytes.Equal(commonMaximum, envelope.MaxFeePerGas) {
			return errors.New("candidate fee caps differ")
		}
	}
	return nil
}

func validUnsignedEnvelope(value *atomicv1.UnsignedType2EnvelopeProposal, chainID, signer, pendingNonce []byte) bool {
	if value == nil || value.TransactionType == nil || value.GetTransactionType() != 2 || len(value.ChainId) != 32 || !bytes.Equal(value.ChainId, chainID) || len(value.Nonce) != 32 || !bytes.Equal(value.Nonce, pendingNonce) || !bytes.Equal(value.Sender, signer) || !validNonzeroAddress(value.Target) || len(value.Value) != 32 || value.Calldata == nil || len(value.Calldata) == 0 || len(value.GasLimit) != 32 || allZero(value.GasLimit) || len(value.MaxPriorityFeePerGas) != 32 || len(value.MaxFeePerGas) != 32 || allZero(value.MaxFeePerGas) || new(big.Int).SetBytes(value.MaxPriorityFeePerGas).Cmp(new(big.Int).SetBytes(value.MaxFeePerGas)) > 0 || !bytes.Equal(value.AccessListRlp, []byte{0xc0}) || value.Serialized == nil {
		return false
	}
	expected := unsignedType2Bytes(value)
	return bytes.Equal(value.Serialized, expected)
}

// EIP-1559 signs 0x02 || rlp([chain, nonce, priority fee, max fee, gas,
// destination, value, data, access list]); integer fields use minimal RLP bytes.
// https://eips.ethereum.org/EIPS/eip-1559
func unsignedType2Bytes(value *atomicv1.UnsignedType2EnvelopeProposal) []byte {
	items := [][]byte{
		rlpBytes(integerBytes(value.ChainId)),
		rlpBytes(integerBytes(value.Nonce)),
		rlpBytes(integerBytes(value.MaxPriorityFeePerGas)),
		rlpBytes(integerBytes(value.MaxFeePerGas)),
		rlpBytes(integerBytes(value.GasLimit)),
		rlpBytes(value.Target),
		rlpBytes(integerBytes(value.Value)),
		rlpBytes(value.Calldata),
		{0xc0},
	}
	payload := bytes.Join(items, nil)
	return append([]byte{2}, rlpList(payload)...)
}

func integerBytes(value []byte) []byte {
	return bytes.TrimLeft(value, "\x00")
}

func rlpBytes(value []byte) []byte {
	if len(value) == 1 && value[0] < 0x80 {
		return append([]byte(nil), value...)
	}
	if len(value) < 56 {
		return append([]byte{0x80 + byte(len(value))}, value...)
	}
	length := integerBytes(new(big.Int).SetInt64(int64(len(value))).Bytes())
	return slices.Concat([]byte{0xb7 + byte(len(length))}, length, value)
}

func rlpList(payload []byte) []byte {
	if len(payload) < 56 {
		return append([]byte{0xc0 + byte(len(payload))}, payload...)
	}
	length := new(big.Int).SetInt64(int64(len(payload))).Bytes()
	return slices.Concat([]byte{0xf7 + byte(len(length))}, length, payload)
}
