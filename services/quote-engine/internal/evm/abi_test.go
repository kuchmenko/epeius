package evm

import (
	"bytes"
	"math/big"
	"testing"

	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
)

func TestERC20Uint256FullWidthAndExactLength(t *testing.T) {
	for _, name := range []string{"balanceOf", "allowance"} {
		for _, raw := range [][]byte{make([]byte, 32), bytes.Repeat([]byte{255}, 32), append([]byte{128}, make([]byte, 31)...)} {
			values, err := Unpack(contractabi.ERC20.Methods[name], raw)
			if err != nil || values[0].(*big.Int).Cmp(new(big.Int).SetBytes(raw)) != 0 {
				t.Fatal(name, values, err)
			}
		}
		for _, size := range []int{0, 31, 33, 64} {
			if _, err := Unpack(contractabi.ERC20.Methods[name], make([]byte, size)); err == nil {
				t.Fatal("accepted wrong word length", name, size)
			}
		}
	}
}
