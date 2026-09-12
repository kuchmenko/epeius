package balancer

import (
	"errors"
	"regexp"

	"github.com/ethereum/go-ethereum/common"
)

// A Balancer pool ID is the 20-byte pool address, 2-byte specialization, and
// 10-byte nonce. All 32 bytes identify the registered pool.
// https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/vault/contracts/PoolRegistry.sol
var poolID = regexp.MustCompile(`^0x[0-9a-f]{64}$`)

type Options struct {
	Vault string
	Pools []string
}

// ParseOptions keeps Balancer's Vault and full bytes32 pool IDs out of the
// common deployment schema. Pool IDs remain lowercase because all 32 bytes,
// including specialization and nonce, are part of the route identity.
func ParseOptions(raw map[string]any) (Options, error) {
	if len(raw) != 2 {
		return Options{}, errors.New("Balancer V2 options must contain only vault and pools")
	}
	vault, vaultOK := raw["vault"].(string)
	values, poolsOK := raw["pools"].([]any)
	if !vaultOK || !common.IsHexAddress(vault) || common.HexToAddress(vault) == (common.Address{}) || !poolsOK || len(values) == 0 {
		return Options{}, errors.New("Balancer V2 options need a nonzero Vault and a non-empty pool array")
	}
	result := Options{Vault: common.HexToAddress(vault).Hex(), Pools: make([]string, 0, len(values))}
	seen := map[string]bool{}
	for _, value := range values {
		id, ok := value.(string)
		if !ok || !poolID.MatchString(id) || seen[id] {
			return Options{}, errors.New("invalid or duplicate Balancer V2 pool ID")
		}
		result.Pools = append(result.Pools, id)
		seen[id] = true
	}
	return result, nil
}
