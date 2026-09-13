package uniswapv4

import (
	"bytes"
	"errors"

	"github.com/ethereum/go-ethereum/common"
)

type Options struct {
	PoolManager     string
	StateView       string
	Permit2         string
	Permit2CodeHash string
	RouterCodeHash  string
	Pools           []Pool
}

type Pool struct {
	Currency0   string
	Currency1   string
	FeePips     uint32
	TickSpacing int32
	Hooks       string
}

// These hashes identify reviewed Universal Router deployments and bind each
// generation to its Permit2 immutable. Uniswap publishes both addresses here:
// https://docs.uniswap.org/contracts/v4/deployments
var reviewedRouterPermit2 = map[common.Hash]struct {
	Address  common.Address
	CodeHash common.Hash
}{
	common.HexToHash("0x27713951fb0660a1422b710122022d90723d883dc7b72949be79cb2957d234e0"): {common.HexToAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"), common.HexToHash("0xa67739abc3ede9dbdc0491636c67d6a14ac07fab9030c3f509b1eb7b11dff8ed")},
	common.HexToHash("0x952c879f642706a4d399eb917827b5a2a5519328446dba72aef3579909bf15ef"): {common.HexToAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"), common.HexToHash("0xdcde65555316946c298e4c60c6213eb5c3aeab4354d1f3fac5427236bcbb9ebe")},
}

func ParseOptions(raw map[string]any) (Options, error) {
	if len(raw) != 6 {
		return Options{}, errors.New("Uniswap V4 options must contain only pool_manager, state_view, permit2, permit2_code_hash, router_code_hash, and pools")
	}
	result := Options{}
	for name, target := range map[string]*string{
		"pool_manager": &result.PoolManager,
		"state_view":   &result.StateView,
		"permit2":      &result.Permit2,
	} {
		value, ok := raw[name].(string)
		if !ok || !common.IsHexAddress(value) || common.HexToAddress(value) == (common.Address{}) {
			return Options{}, errors.New("Uniswap V4 option addresses must be nonzero EVM addresses")
		}
		*target = common.HexToAddress(value).Hex()
	}
	routerCodeHash, ok := raw["router_code_hash"].(string)
	if !ok || !common.IsHexHash(routerCodeHash) {
		return Options{}, errors.New("Uniswap V4 router_code_hash must be a 32-byte hash")
	}
	result.RouterCodeHash = common.HexToHash(routerCodeHash).Hex()
	permit2CodeHash, ok := raw["permit2_code_hash"].(string)
	if !ok || !common.IsHexHash(permit2CodeHash) {
		return Options{}, errors.New("Uniswap V4 permit2_code_hash must be a 32-byte hash")
	}
	result.Permit2CodeHash = common.HexToHash(permit2CodeHash).Hex()
	reviewed, known := reviewedRouterPermit2[common.HexToHash(routerCodeHash)]
	if !known || common.HexToAddress(result.Permit2) != reviewed.Address || common.HexToHash(permit2CodeHash) != reviewed.CodeHash {
		return Options{}, errors.New("Uniswap V4 router and Permit2 must name a reviewed deployment")
	}
	values, ok := raw["pools"].([]any)
	if !ok || len(values) == 0 {
		return Options{}, errors.New("Uniswap V4 pools must be a non-empty array")
	}
	seen := map[Pool]bool{}
	for _, value := range values {
		fields, ok := value.(map[string]any)
		if !ok || len(fields) != 5 {
			return Options{}, errors.New("invalid Uniswap V4 pool")
		}
		currency0, zeroOK := fields["currency0"].(string)
		currency1, oneOK := fields["currency1"].(string)
		hooks, hooksOK := fields["hooks"].(string)
		fee, feeOK := fields["fee_pips"].(int64)
		spacing, spacingOK := fields["tick_spacing"].(int64)
		if !zeroOK || !oneOK || !hooksOK || !feeOK || !spacingOK || !common.IsHexAddress(currency0) || !common.IsHexAddress(currency1) || !common.IsHexAddress(hooks) {
			return Options{}, errors.New("invalid Uniswap V4 pool")
		}
		zero, one := common.HexToAddress(currency0), common.HexToAddress(currency1)
		pool := Pool{zero.Hex(), one.Hex(), uint32(fee), int32(spacing), common.HexToAddress(hooks).Hex()}
		if zero == (common.Address{}) || one == (common.Address{}) || bytes.Compare(zero[:], one[:]) >= 0 || fee < 0 || fee > 1000000 || fee == 0x800000 || spacing <= 0 || spacing > 32767 || common.HexToAddress(hooks) != (common.Address{}) || seen[pool] {
			return Options{}, errors.New("invalid or duplicate Uniswap V4 pool")
		}
		seen[pool] = true
		result.Pools = append(result.Pools, pool)
	}
	return result, nil
}
