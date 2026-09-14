// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapRouter02V2 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Executes the first narrow slice of the ExecutorV2 plan ABI: one Uniswap V3 operation.
contract ExecutorV2 {
    using SafeERC20 for IERC20;

    struct Operation {
        uint8 kind;
        address tokenOut;
        uint24 fee;
        int24 tickSpacing;
        bytes32 poolId;
    }

    struct Branch {
        uint256 amountIn;
        uint256 minAmountOut;
        Operation[] operations;
    }

    struct Plan {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        Branch[] branches;
    }

    uint8 private constant UNISWAP_V3 = 1;

    address public immutable uniswapRouter;
    bool private entered;

    error ReentrantCall();
    error NonCanonicalEncoding();
    error Expired(uint256 deadline, uint256 timestamp);
    error InvalidPlan();
    error UnsupportedKind(uint8 kind);
    error InvalidOperation(uint256 branchIndex, uint256 operationIndex);
    error ProtocolCallFailed(uint256 branchIndex, uint256 operationIndex, bytes reason);
    error BalanceMismatch(address token, address owner, uint256 expected, uint256 actual);
    error OutputNotIncreased(uint256 branchIndex, uint256 operationIndex);
    error BranchMinimumNotMet(uint256 branchIndex, uint256 minimum, uint256 actual);
    error PlanMinimumNotMet(uint256 minimum, uint256 actual);
    error InvalidDeployment();

    event OperationExecuted(
        bytes32 indexed planHash,
        uint256 indexed branchIndex,
        uint256 indexed operationIndex,
        uint8 kind,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event BranchExecuted(bytes32 indexed planHash, uint256 indexed branchIndex, uint256 amountIn, uint256 amountOut);
    event PlanExecuted(
        bytes32 indexed planHash,
        address indexed caller,
        address indexed tokenOut,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address uniswapRouter_) {
        if (uniswapRouter_.code.length == 0) revert InvalidDeployment();
        uniswapRouter = uniswapRouter_;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function version() external pure returns (uint256) {
        return 2;
    }

    function execute(Plan calldata plan) external nonReentrant returns (uint256 amountOut) {
        if (keccak256(msg.data[4:]) != keccak256(abi.encode(plan))) revert NonCanonicalEncoding();
        if (block.timestamp > plan.deadline) revert Expired(plan.deadline, block.timestamp);
        _validate(plan);

        bytes32 planHash = keccak256(abi.encode(uint256(2), block.chainid, address(this), msg.sender, plan));
        Branch calldata branch = plan.branches[0];
        Operation calldata operation = branch.operations[0];
        IERC20 input = IERC20(plan.tokenIn);
        IERC20 output = IERC20(plan.tokenOut);
        uint256 entryInput = input.balanceOf(address(this));
        uint256 entryOutput = output.balanceOf(address(this));

        _pullInput(input, plan.amountIn, entryInput);
        amountOut = _swap(plan, operation, entryInput, entryOutput);
        emit OperationExecuted(
            planHash, 0, 0, operation.kind, plan.tokenIn, operation.tokenOut, plan.amountIn, amountOut
        );

        if (amountOut < branch.minAmountOut) revert BranchMinimumNotMet(0, branch.minAmountOut, amountOut);
        emit BranchExecuted(planHash, 0, branch.amountIn, amountOut);
        if (amountOut < plan.minAmountOut) revert PlanMinimumNotMet(plan.minAmountOut, amountOut);

        _payOutput(output, amountOut);
        _requireBalance(input, address(this), entryInput);
        _requireBalance(output, address(this), entryOutput);
        emit PlanExecuted(planHash, msg.sender, plan.tokenOut, plan.tokenIn, plan.amountIn, amountOut);
    }

    function _validate(Plan calldata plan) private view {
        if (
            plan.tokenIn == address(0) || plan.tokenOut == address(0) || plan.tokenIn == plan.tokenOut
                || plan.tokenIn == address(this) || plan.tokenOut == address(this) || plan.tokenIn.code.length == 0
                || plan.tokenOut.code.length == 0 || plan.amountIn == 0 || plan.minAmountOut == 0
                || plan.branches.length != 1
        ) revert InvalidPlan();

        Branch calldata branch = plan.branches[0];
        if (branch.amountIn != plan.amountIn || branch.minAmountOut == 0 || branch.operations.length != 1) {
            revert InvalidPlan();
        }

        Operation calldata operation = branch.operations[0];
        if (operation.kind != UNISWAP_V3) revert UnsupportedKind(operation.kind);
        if (
            operation.tokenOut != plan.tokenOut || operation.tokenOut.code.length == 0 || operation.fee >= 1_000_000
                || operation.tickSpacing != 0 || operation.poolId != bytes32(0)
        ) revert InvalidOperation(0, 0);
    }

    function _pullInput(IERC20 input, uint256 amountIn, uint256 entryInput) private {
        uint256 callerInput = input.balanceOf(msg.sender);
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        _requireBalance(input, address(this), entryInput + amountIn);
        _requireBalance(input, msg.sender, callerInput - amountIn);
    }

    function _swap(Plan calldata plan, Operation calldata operation, uint256 entryInput, uint256 entryOutput)
        private
        returns (uint256 amountOut)
    {
        IERC20 input = IERC20(plan.tokenIn);
        input.forceApprove(uniswapRouter, plan.amountIn);
        try IUniswapRouter02V2(uniswapRouter)
            .exactInputSingle(
                IUniswapRouter02V2.ExactInputSingleParams(
                    plan.tokenIn,
                    operation.tokenOut,
                    operation.fee,
                    address(this),
                    plan.amountIn,
                    plan.branches[0].minAmountOut,
                    0
                )
            ) {}
        catch (bytes memory reason) {
            revert ProtocolCallFailed(0, 0, reason);
        }
        input.forceApprove(uniswapRouter, 0);
        _requireBalance(input, address(this), entryInput);

        uint256 finalOutput = IERC20(operation.tokenOut).balanceOf(address(this));
        if (finalOutput <= entryOutput) revert OutputNotIncreased(0, 0);
        return finalOutput - entryOutput;
    }

    function _payOutput(IERC20 output, uint256 amountOut) private {
        uint256 callerOutput = output.balanceOf(msg.sender);
        output.safeTransfer(msg.sender, amountOut);
        _requireBalance(output, msg.sender, callerOutput + amountOut);
    }

    function _requireBalance(IERC20 token, address owner, uint256 expected) private view {
        uint256 actual = token.balanceOf(owner);
        if (actual != expected) revert BalanceMismatch(address(token), owner, expected, actual);
    }
}
