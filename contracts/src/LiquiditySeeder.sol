// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function mint(address, int24, int24, uint128, bytes calldata) external returns (uint256, uint256);
}

interface IV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice Permanent test liquidity, not an NFT manager. Swaps use the real V3 routers.
contract LiquiditySeeder {
    using SafeERC20 for IERC20;
    address public immutable owner = msg.sender;
    address private activePool;

    function seed(address factory, address pool, int24 lower, int24 upper, uint128 liquidity) external {
        require(msg.sender == owner, "owner only");
        require(activePool == address(0), "mint active");
        IV3Pool p = IV3Pool(pool);
        require(IV3Factory(factory).getPool(p.token0(), p.token1(), p.fee()) == pool, "wrong pool");
        activePool = pool;
        p.mint(address(this), lower, upper, liquidity, "");
        activePool = address(0);
    }

    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata) external {
        pay(amount0, amount1);
    }

    function pancakeV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata) external {
        pay(amount0, amount1);
    }

    function pay(uint256 amount0, uint256 amount1) private {
        require(msg.sender == activePool && activePool != address(0), "unexpected callback");
        IV3Pool p = IV3Pool(msg.sender);
        if (amount0 != 0) IERC20(p.token0()).safeTransferFrom(owner, msg.sender, amount0);
        if (amount1 != 0) IERC20(p.token1()).safeTransferFrom(owner, msg.sender, amount1);
    }
}
