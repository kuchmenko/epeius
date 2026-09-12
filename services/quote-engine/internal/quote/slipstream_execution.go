package quote

import (
	"context"
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/config"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/contractabi"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/evm"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

func verifySlipstreamDeployment(ctx context.Context, reader codeReader, deployment config.Deployment, hash common.Hash) error {
	fail := errors.New("deployment code or factory linkage verification failed")
	for _, target := range []string{deployment.Factory, deployment.Quoter, deployment.Router} {
		code, err := reader.Code(ctx, common.HexToAddress(target), hash)
		if err != nil || len(code) == 0 {
			return fail
		}
	}
	factory := common.HexToAddress(deployment.Factory)
	linkedFactory := func(target string, contract abi.ABI) error {
		method := contract.Methods["factory"]
		data, err := reader.Call(ctx, common.HexToAddress(target), method.ID, hash)
		if err != nil {
			return fail
		}
		values, err := evm.Unpack(method, data)
		if err != nil || values[0].(common.Address) != factory {
			return fail
		}
		return nil
	}
	if err := linkedFactory(deployment.Quoter, contractabi.AerodromeSlipstreamQuoterV2); err != nil {
		return fail
	}
	if err := linkedFactory(deployment.Router, contractabi.AerodromeSlipstreamRouter); err != nil {
		return fail
	}
	if _, err := verifiedSlipstreamFeeModule(ctx, reader, hash, factory); err != nil {
		return fail
	}
	return nil
}

func verifiedSlipstreamFeeModule(ctx context.Context, reader Reader, hash common.Hash, factory common.Address) (common.Address, error) {
	code, ok := reader.(codeReader)
	if !ok {
		return common.Address{}, errors.New("contract code unavailable")
	}
	module, err := slipstreamFeeModule(ctx, reader, hash, factory)
	if err != nil {
		return common.Address{}, err
	}
	deployed, err := code.Code(ctx, module, hash)
	if err != nil || len(deployed) == 0 {
		return common.Address{}, errors.New("fee module code unavailable")
	}
	moduleFactory := contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["factory"]
	data, err := reader.Call(ctx, module, moduleFactory.ID, hash)
	if err != nil {
		return common.Address{}, err
	}
	values, err := evm.Unpack(moduleFactory, data)
	if err != nil || values[0].(common.Address) != factory {
		return common.Address{}, errors.New("fee module factory linkage failed")
	}
	return module, nil
}

func slipstreamFeeModule(ctx context.Context, reader Reader, hash common.Hash, factory common.Address) (common.Address, error) {
	getter := contractabi.AerodromeSlipstreamFactory.Methods["swapFeeModule"]
	data, err := reader.Call(ctx, factory, getter.ID, hash)
	if err != nil {
		return common.Address{}, err
	}
	values, err := evm.Unpack(getter, data)
	if err != nil {
		return common.Address{}, err
	}
	module := values[0].(common.Address)
	if module == (common.Address{}) {
		return common.Address{}, errors.New("fee module code unavailable")
	}
	return module, nil
}

func slipstreamDiscount(ctx context.Context, reader Reader, hash common.Hash, module, account common.Address) (*big.Int, error) {
	call, err := contractabi.AerodromeSlipstreamDynamicFeeModule.Pack("discounted", account)
	if err != nil {
		return nil, err
	}
	data, err := reader.Call(ctx, module, call, hash)
	if err != nil {
		if errors.Is(err, rpc.ErrExecutionReverted) {
			return nil, nil
		}
		return nil, err
	}
	values, err := evm.Unpack(contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["discounted"], data)
	if err != nil {
		return nil, err
	}
	return values[0].(*big.Int), nil
}

func verifySlipstreamQuoteOrigin(ctx context.Context, reader Reader, hash common.Hash, factory common.Address) error {
	// DynamicSwapFeeModule applies discounted[tx.origin], so the explicit zero
	// eth_call origin must be undiscounted at the same block as the quote.
	// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/fees/DynamicSwapFeeModule.sol#L182-L191
	module, err := slipstreamFeeModule(ctx, reader, hash, factory)
	if err != nil {
		return errors.New("Slipstream quote-origin fee check failed")
	}
	discount, err := slipstreamDiscount(ctx, reader, hash, module, common.Address{})
	if err != nil {
		return errors.New("Slipstream quote-origin fee check failed")
	}
	if discount != nil && discount.Sign() != 0 {
		return errors.New("Slipstream quote origin has a fee discount")
	}
	return nil
}

// Dynamic fee modules can vary fees by tx.origin, while IFeeModule does not
// require the optional discounted(address) getter used to detect that policy.
// https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/interfaces/fees/IFeeModule.sol#L6-L15
// Informational quotes have no signer, so execution rejects known discounts;
// canonical static modules revert the optional getter and remain executable.
func verifySlipstreamSignerDiscount(ctx context.Context, reader Reader, hash common.Hash, factory common.Address, signer string) string {
	const fail = "Slipstream fee discount check failed"
	module, err := verifiedSlipstreamFeeModule(ctx, reader, hash, factory)
	if err != nil {
		return fail
	}
	discount, err := slipstreamDiscount(ctx, reader, hash, module, common.HexToAddress(signer))
	if err != nil {
		return fail
	}
	if discount != nil && discount.Sign() != 0 {
		return "Signer has a Slipstream tx.origin fee discount"
	}
	return ""
}
