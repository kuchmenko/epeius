package slipstream

import "errors"

const (
	// Slipstream keys pools by Solidity int24 tick spacing.
	// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/interfaces/ICLFactory.sol#L112-L118
	MinTickSpacing int32 = -(1 << 23)
	MaxTickSpacing int32 = 1<<23 - 1
)

type Options struct {
	TickSpacings []int32
}

// ParseOptions keeps Slipstream's signed int24 pool selector out of the common
// deployment schema. TOML numbers decode as int64 values inside an open table.
func ParseOptions(raw map[string]any) (Options, error) {
	if len(raw) != 1 {
		return Options{}, errors.New("Slipstream options must contain only tick_spacings")
	}
	values, ok := raw["tick_spacings"].([]any)
	if !ok || len(values) == 0 {
		return Options{}, errors.New("Slipstream tick_spacings must be a non-empty array")
	}
	result := Options{TickSpacings: make([]int32, 0, len(values))}
	seen := map[int32]bool{}
	for _, value := range values {
		spacing, ok := value.(int64)
		if !ok || spacing < int64(MinTickSpacing) || spacing > int64(MaxTickSpacing) || seen[int32(spacing)] {
			return Options{}, errors.New("invalid or duplicate Slipstream tick spacing")
		}
		result.TickSpacings = append(result.TickSpacings, int32(spacing))
		seen[int32(spacing)] = true
	}
	return result, nil
}
