package uniswapv3

import (
	_ "embed"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// These are complete upstream ABIs. See abi/NOTICE for pinned sources and license.
//
//go:embed abi/IUniswapV3Factory.json
var factoryJSON string

//go:embed abi/IQuoterV2.json
var quoterJSON string

var factoryABI = parseABI(factoryJSON)
var quoterABI = parseABI(quoterJSON)

func parseABI(source string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(source))
	if err != nil {
		panic(err) // Embedded build input, not user or RPC data.
	}
	return parsed
}
