// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import "@pancakeswap/v3-core/contracts/PancakeV3PoolDeployer.sol";
import "@pancakeswap/v3-core/contracts/PancakeV3Factory.sol";

/// @notice Atomic initialization prevents anyone taking the public one-time factory setter.
contract PancakeBootstrap {
    address public immutable deployer;
    address public immutable factory;

    constructor() {
        PancakeV3PoolDeployer d = new PancakeV3PoolDeployer();
        PancakeV3Factory f = new PancakeV3Factory(address(d));
        d.setFactoryAddress(address(f));
        f.setOwner(msg.sender);
        deployer = address(d);
        factory = address(f);
    }
}
