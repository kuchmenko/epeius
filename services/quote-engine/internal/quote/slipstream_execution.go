package quote

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
)

func slipstreamDiscountCheck(d config.Deployment) func(string) func(context.Context, Reader, common.Hash) string {
	return func(signer string) func(context.Context, Reader, common.Hash) string {
		return func(ctx context.Context, reader Reader, hash common.Hash) string {
			fail := "Slipstream fee discount check failed"
			code, ok := reader.(codeReader)
			if !ok {
				return fail
			}
			getter := contractabi.AerodromeSlipstreamFactory.Methods["swapFeeModule"]
			data, err := reader.Call(ctx, common.HexToAddress(d.Factory), getter.ID, hash)
			if err != nil {
				return fail
			}
			values, err := evm.Unpack(getter, data)
			if err != nil {
				return fail
			}
			module := values[0].(common.Address)
			if module == (common.Address{}) {
				return fail
			}
			deployed, err := code.Code(ctx, module, hash)
			if err != nil || len(deployed) == 0 {
				return fail
			}
			moduleFactory := contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["factory"]
			data, err = reader.Call(ctx, module, moduleFactory.ID, hash)
			if err != nil {
				return fail
			}
			values, err = evm.Unpack(moduleFactory, data)
			if err != nil || values[0].(common.Address) != common.HexToAddress(d.Factory) {
				return fail
			}
			call, err := contractabi.AerodromeSlipstreamDynamicFeeModule.Pack("discounted", common.HexToAddress(signer))
			if err != nil {
				return fail
			}
			data, err = reader.Call(ctx, module, call, hash)
			if err != nil {
				return fail
			}
			values, err = evm.Unpack(contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["discounted"], data)
			if err != nil {
				return fail
			}
			if values[0].(*big.Int).Sign() != 0 {
				return "Signer has a Slipstream tx.origin fee discount"
			}
			return ""
		}
	}
}
