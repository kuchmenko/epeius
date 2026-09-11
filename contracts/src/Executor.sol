// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface IPancakeRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// @notice Caller-chosen exact-input routes. Venue 0 is Uniswap SwapRouter02; 1 is Pancake V3 SwapRouter.
contract Executor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Hop {
        address tokenOut;
        uint24 fee;
    }

    struct Allocation {
        uint8 venue;
        uint256 amountIn;
        Hop[] hops;
    }

    address public immutable uniswapRouter;
    address public immutable pancakeRouter;

    error InvalidPlan();
    error Expired();
    error BalanceMismatch();
    error IncompleteSpend();
    error InsufficientOutput();

    constructor(address uniswapRouter_, address pancakeRouter_) {
        if (uniswapRouter_.code.length == 0 || pancakeRouter_.code.length == 0 || uniswapRouter_ == pancakeRouter_) {
            revert InvalidPlan();
        }
        uniswapRouter = uniswapRouter_;
        pancakeRouter = pancakeRouter_;
    }

    function execute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        Allocation[] calldata allocations
    ) external nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        (address[4] memory tokens, uint256 tokenCount) = validate(tokenIn, tokenOut, amountIn, allocations);
        uint256[4] memory balances;
        for (uint256 i; i < tokenCount; ++i) {
            balances[i] = IERC20(tokens[i]).balanceOf(address(this));
        }

        uint256 callerInput = IERC20(tokenIn).balanceOf(msg.sender);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (
            IERC20(tokenIn).balanceOf(address(this)) != balances[0] + amountIn
                || IERC20(tokenIn).balanceOf(msg.sender) + amountIn != callerInput
        ) revert BalanceMismatch();

        amountOut = executeRoutes(tokenIn, deadline, allocations);
        if (amountOut < minAmountOut) revert InsufficientOutput();
        uint256 callerOutput = IERC20(tokenOut).balanceOf(msg.sender);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        if (IERC20(tokenOut).balanceOf(msg.sender) != callerOutput + amountOut) revert BalanceMismatch();
        for (uint256 i; i < tokenCount; ++i) {
            if (IERC20(tokens[i]).balanceOf(address(this)) != balances[i]) revert BalanceMismatch();
        }
    }

    function validate(address tokenIn, address tokenOut, uint256 amountIn, Allocation[] calldata allocations)
        private
        view
        returns (address[4] memory tokens, uint256 tokenCount)
    {
        if (
            tokenIn == tokenOut || tokenIn.code.length == 0 || tokenOut.code.length == 0 || amountIn == 0
                || allocations.length == 0 || allocations.length > 2
        ) revert InvalidPlan();
        if (allocations.length == 2 && allocations[0].venue == allocations[1].venue) revert InvalidPlan();

        // At most four unique touched tokens: input, output, and one intermediate per allocation.
        tokens[0] = tokenIn;
        tokens[1] = tokenOut;
        tokenCount = 2;
        uint256 remaining = amountIn;
        for (uint256 i; i < allocations.length; ++i) {
            Allocation calldata allocation = allocations[i];
            if (
                allocation.venue > 1 || allocation.amountIn == 0 || allocation.amountIn > remaining
                    || allocation.hops.length == 0 || allocation.hops.length > 2
            ) revert InvalidPlan();
            remaining -= allocation.amountIn;
            address previous = tokenIn;
            for (uint256 j; j < allocation.hops.length; ++j) {
                address next = allocation.hops[j].tokenOut;
                if (next.code.length == 0 || next == previous || next == tokenIn) revert InvalidPlan();
                if (j + 1 == allocation.hops.length) {
                    if (next != tokenOut) revert InvalidPlan();
                } else {
                    if (next == tokenOut) revert InvalidPlan();
                    if (tokenCount == 2 || tokens[2] != next) tokens[tokenCount++] = next;
                }
                previous = next;
            }
        }
        if (remaining != 0) revert InvalidPlan();
    }

    function executeRoutes(address tokenIn, uint256 deadline, Allocation[] calldata allocations)
        private
        returns (uint256 amountOut)
    {
        for (uint256 i; i < allocations.length; ++i) {
            Allocation calldata allocation = allocations[i];
            uint256 output = allocation.amountIn;
            address input = tokenIn;
            for (uint256 j; j < allocation.hops.length; ++j) {
                Hop calldata hop = allocation.hops[j];
                output = swap(allocation.venue, input, hop, output, deadline);
                input = hop.tokenOut;
            }
            amountOut += output;
        }
    }

    function swap(uint8 venue, address tokenIn, Hop calldata hop, uint256 amountIn, uint256 deadline)
        private
        returns (uint256 amountOut)
    {
        // In SwapRouter02, zero means spend the router's own balance, not a zero-size trade.
        if (amountIn == 0) revert InvalidPlan();
        address router = venue == 0 ? uniswapRouter : pancakeRouter;
        IERC20 input = IERC20(tokenIn);
        uint256 beforeInput = input.balanceOf(address(this));
        uint256 beforeOutput = IERC20(hop.tokenOut).balanceOf(address(this));
        input.forceApprove(router, amountIn);
        if (venue == 0) {
            IUniswapRouter02(router)
                .exactInputSingle(
                    IUniswapRouter02.ExactInputSingleParams(
                        tokenIn, hop.tokenOut, hop.fee, address(this), amountIn, 0, 0
                    )
                );
        } else {
            IPancakeRouter(router)
                .exactInputSingle(
                    IPancakeRouter.ExactInputSingleParams(
                        tokenIn, hop.tokenOut, hop.fee, address(this), deadline, amountIn, 0, 0
                    )
                );
        }
        input.forceApprove(router, 0);
        if (input.balanceOf(address(this)) + amountIn != beforeInput) revert IncompleteSpend();
        amountOut = IERC20(hop.tokenOut).balanceOf(address(this)) - beforeOutput;
    }
}
