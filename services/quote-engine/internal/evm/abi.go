// Package evm contains strict ABI operations shared by EVM consumers.
package evm

import (
	"bytes"
	"errors"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// Method resolves overloaded methods by canonical signature, never map suffix.
func Method(contract abi.ABI, signature string) abi.Method {
	for _, method := range contract.Methods {
		if method.Sig == signature {
			return method
		}
	}
	panic("missing embedded ABI method: " + signature)
}

// Unpack rejects padding, trailing bytes and noncanonical encodings that the
// SDK decoder alone accepts. The method comes from a pinned contract artifact.
func Unpack(method abi.Method, data []byte) ([]any, error) {
	values, err := method.Outputs.Unpack(data)
	if err != nil {
		return nil, err
	}
	encoded, err := method.Outputs.Pack(values...)
	if err != nil || !bytes.Equal(encoded, data) {
		return nil, errors.New("noncanonical ABI result")
	}
	return values, nil
}
