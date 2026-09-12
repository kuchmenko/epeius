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
	deployed, err := code.Code(ctx, module, hash)
	if module == (common.Address{}) || err != nil || len(deployed) == 0 {
		return common.Address{}, errors.New("fee module code unavailable")
	}
	moduleFactory := contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["factory"]
	data, err = reader.Call(ctx, module, moduleFactory.ID, hash)
	if err != nil {
		return common.Address{}, err
	}
	values, err = evm.Unpack(moduleFactory, data)
	if err != nil || values[0].(common.Address) != factory {
		return common.Address{}, errors.New("fee module factory linkage failed")
	}
	return module, nil
}

// Slipstream's FeeModule can vary fees by tx.origin. Informational quotes have
// no signer, so execution rejects discounted signers rather than presenting
// account-independent output as executable output.
func verifySlipstreamSignerDiscount(ctx context.Context, reader Reader, hash common.Hash, factory common.Address, signer string) string {
	const fail = "Slipstream fee discount check failed"
	module, err := verifiedSlipstreamFeeModule(ctx, reader, hash, factory)
	if err != nil {
		return fail
	}
	call, err := contractabi.AerodromeSlipstreamDynamicFeeModule.Pack("discounted", common.HexToAddress(signer))
	if err != nil {
		return fail
	}
	data, err := reader.Call(ctx, module, call, hash)
	if err != nil {
		return fail
	}
	values, err := evm.Unpack(contractabi.AerodromeSlipstreamDynamicFeeModule.Methods["discounted"], data)
	if err != nil {
		return fail
	}
	if values[0].(*big.Int).Sign() != 0 {
		return "Signer has a Slipstream tx.origin fee discount"
	}
	return ""
}
