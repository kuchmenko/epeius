// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only standard ERC20. Only its deployer can mint.
contract TestToken is ERC20 {
    address public immutable owner = msg.sender;
    uint8 private immutable tokenDecimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    function mint(address recipient, uint256 amount) external {
        require(msg.sender == owner, "owner only");
        _mint(recipient, amount);
    }
}
