package quote

import (
	"errors"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/providers/slipstream"
)

var erc20ABI = contractabi.ERC20
var uniRouterABI = contractabi.UniswapRouter02
var pancakeRouterABI = contractabi.PancakeV3Router
var slipstreamRouterABI = contractabi.AerodromeSlipstreamRouter
var uniDeadlineCall = evm.Method(uniRouterABI, "multicall(uint256,bytes[])")

const slipstreamTickSpacingMask uint32 = 1<<24 - 1

func v3Path(route *quotev1.RouteQuote) ([]byte, error) {
	if len(route.Legs) < 1 || len(route.Legs) > 2 {
		return nil, errors.New("unsupported path")
	}
	var path []byte
	for i, leg := range route.Legs {
		fee, ok := leg.Selector.(*quotev1.RouteLeg_FeePips)
		if !ok || fee.FeePips >= 1000000 || !validAddress(leg.TokenIn) || !validAddress(leg.TokenOut) || i > 0 && !strings.EqualFold(route.Legs[i-1].TokenOut, leg.TokenIn) {
			return nil, errors.New("invalid path")
		}
		path = append(path, common.HexToAddress(leg.TokenIn).Bytes()...)
		path = append(path, byte(fee.FeePips>>16), byte(fee.FeePips>>8), byte(fee.FeePips))
	}
	path = append(path, common.HexToAddress(route.Legs[len(route.Legs)-1].TokenOut).Bytes()...)
	return path, nil
}

func slipstreamPath(route *quotev1.RouteQuote) ([]byte, error) {
	if len(route.Legs) < 1 || len(route.Legs) > 2 {
		return nil, errors.New("unsupported path")
	}
	var path []byte
	for i, leg := range route.Legs {
		selector, ok := leg.Selector.(*quotev1.RouteLeg_TickSpacing)
		if !ok || selector.TickSpacing < slipstream.MinTickSpacing || selector.TickSpacing > slipstream.MaxTickSpacing || !validAddress(leg.TokenIn) || !validAddress(leg.TokenOut) || i > 0 && !strings.EqualFold(route.Legs[i-1].TokenOut, leg.TokenIn) {
			return nil, errors.New("invalid path")
		}
		// Slipstream exact-input paths use address | int24 | address, then repeat
		// int24 | address for each next hop. Masking preserves int24 two's-complement.
		// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/libraries/Path.sol#L10-L50
		value := uint32(selector.TickSpacing) & slipstreamTickSpacingMask
		path = append(path, common.HexToAddress(leg.TokenIn).Bytes()...)
		path = append(path, byte(value>>16), byte(value>>8), byte(value))
	}
	return append(path, common.HexToAddress(route.Legs[len(route.Legs)-1].TokenOut).Bytes()...), nil
}

func slipstreamRouterData(route *quotev1.RouteQuote, sender string, amount, minimum *big.Int, deadline uint64) ([]byte, error) {
	path, err := slipstreamPath(route)
	if err != nil {
		return nil, err
	}
	return slipstreamRouterABI.Pack("exactInput", struct {
		Path                                 []byte
		Recipient                            common.Address
		Deadline, AmountIn, AmountOutMinimum *big.Int
	}{path, common.HexToAddress(sender), new(big.Int).SetUint64(deadline), amount, minimum})
}

func pancakeV3RouterData(route *quotev1.RouteQuote, sender string, amount, minimum *big.Int, deadline uint64) ([]byte, error) {
	path, err := v3Path(route)
	if err != nil {
		return nil, err
	}
	return pancakeRouterABI.Pack("exactInput", struct {
		Path                                 []byte
		Recipient                            common.Address
		Deadline, AmountIn, AmountOutMinimum *big.Int
	}{path, common.HexToAddress(sender), new(big.Int).SetUint64(deadline), amount, minimum})
}

func uniswapRouter02Data(route *quotev1.RouteQuote, sender string, amount, minimum *big.Int, deadline uint64) ([]byte, error) {
	path, err := v3Path(route)
	if err != nil {
		return nil, err
	}
	inner, err := uniRouterABI.Pack("exactInput", struct {
		Path                       []byte
		Recipient                  common.Address
		AmountIn, AmountOutMinimum *big.Int
	}{path, common.HexToAddress(sender), amount, minimum})
	if err != nil {
		return nil, err
	}
	return uniRouterABI.Pack(uniDeadlineCall.Name, new(big.Int).SetUint64(deadline), [][]byte{inner})
}
