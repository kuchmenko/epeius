package quote

import (
	"errors"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
)

var erc20ABI = contractabi.ERC20
var uniRouterABI = contractabi.UniswapRouter02
var pancakeRouterABI = contractabi.PancakeV3Router
var uniDeadlineCall = evm.Method(uniRouterABI, "multicall(uint256,bytes[])")

func v3Path(route *quotev1.RouteQuote) ([]byte, error) {
	if len(route.Legs) < 1 || len(route.Legs) > 2 {
		return nil, errors.New("unsupported path")
	}
	var path []byte
	for i, leg := range route.Legs {
		fee, ok := leg.Selector.(*quotev1.RouteLeg_FeePips)
		if !ok || fee.FeePips >= 1000000 || !address.MatchString(leg.TokenIn) || !address.MatchString(leg.TokenOut) || i > 0 && !strings.EqualFold(route.Legs[i-1].TokenOut, leg.TokenIn) {
			return nil, errors.New("invalid path")
		}
		path = append(path, common.HexToAddress(leg.TokenIn).Bytes()...)
		path = append(path, byte(fee.FeePips>>16), byte(fee.FeePips>>8), byte(fee.FeePips))
	}
	path = append(path, common.HexToAddress(route.Legs[len(route.Legs)-1].TokenOut).Bytes()...)
	return path, nil
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
