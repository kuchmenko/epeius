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

/// @notice Executes the first narrow slice of the ExecutorV2 plan ABI: one branch of up to two Uniswap V3 operations.
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

    struct SwapRequest {
        address tokenIn;
        uint256 amountIn;
        uint256 minimum;
        uint256 entryInput;
        uint256 entryOutput;
        uint256 operationIndex;
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
        IERC20 input = IERC20(plan.tokenIn);
        IERC20 output = IERC20(plan.tokenOut);
        uint256 entryInput = input.balanceOf(address(this));
        uint256 entryOutput = output.balanceOf(address(this));
        uint256 entryIntermediate;
        if (branch.operations.length == 2) {
            entryIntermediate = IERC20(branch.operations[0].tokenOut).balanceOf(address(this));
        }

        _pullInput(input, plan.amountIn, entryInput);
        amountOut =
            _executeBranch(planHash, branch, plan.tokenIn, plan.amountIn, entryInput, entryIntermediate, entryOutput);

        if (amountOut < branch.minAmountOut) revert BranchMinimumNotMet(0, branch.minAmountOut, amountOut);
        emit BranchExecuted(planHash, 0, branch.amountIn, amountOut);
        if (amountOut < plan.minAmountOut) revert PlanMinimumNotMet(plan.minAmountOut, amountOut);

        _payOutput(output, amountOut);
        _requireBalance(input, address(this), entryInput);
        if (branch.operations.length == 2) {
            _requireBalance(IERC20(branch.operations[0].tokenOut), address(this), entryIntermediate);
        }
        _requireBalance(output, address(this), entryOutput);
        emit PlanExecuted(planHash, msg.sender, plan.tokenOut, plan.tokenIn, plan.amountIn, amountOut);
    }

    function _executeBranch(
        bytes32 planHash,
        Branch calldata branch,
        address tokenIn,
        uint256 amountIn,
        uint256 entryInput,
        uint256 entryIntermediate,
        uint256 entryOutput
    ) private returns (uint256 amountOut) {
        address currentToken = tokenIn;
        uint256 currentAmount = amountIn;
        for (uint256 i; i < branch.operations.length; ++i) {
            Operation calldata operation = branch.operations[i];
            bool finalOperation = i + 1 == branch.operations.length;
            SwapRequest memory request = SwapRequest(
                currentToken,
                currentAmount,
                finalOperation ? branch.minAmountOut : 1,
                i == 0 ? entryInput : entryIntermediate,
                finalOperation ? entryOutput : entryIntermediate,
                i
            );
            amountOut = _swap(operation, request);
            emit OperationExecuted(
                planHash, 0, i, operation.kind, currentToken, operation.tokenOut, currentAmount, amountOut
            );
            currentToken = operation.tokenOut;
            currentAmount = amountOut;
        }
    }

    function _validate(Plan calldata plan) private view {
        if (
            plan.tokenIn == address(0) || plan.tokenOut == address(0) || plan.tokenIn == plan.tokenOut
                || plan.tokenIn == address(this) || plan.tokenOut == address(this) || plan.tokenIn.code.length == 0
                || plan.tokenOut.code.length == 0 || plan.amountIn == 0 || plan.minAmountOut == 0
                || plan.branches.length != 1
        ) revert InvalidPlan();

        Branch calldata branch = plan.branches[0];
        if (
            branch.amountIn != plan.amountIn || branch.minAmountOut == 0 || branch.operations.length == 0
                || branch.operations.length > 2
        ) {
            revert InvalidPlan();
        }

        address currentToken = plan.tokenIn;
        for (uint256 i; i < branch.operations.length; ++i) {
            Operation calldata operation = branch.operations[i];
            if (operation.kind != UNISWAP_V3) revert UnsupportedKind(operation.kind);
            if (
                operation.tokenOut == currentToken || operation.tokenOut.code.length == 0 || operation.fee >= 1_000_000
                    || operation.tickSpacing != 0 || operation.poolId != bytes32(0)
            ) revert InvalidOperation(0, i);
            currentToken = operation.tokenOut;
        }
        if (currentToken != plan.tokenOut) revert InvalidOperation(0, branch.operations.length - 1);
        if (branch.operations.length == 2) {
            Operation calldata first = branch.operations[0];
            Operation calldata second = branch.operations[1];
            // One immutable router means a V3 pool is uniquely identified by its unordered token pair and fee.
            // https://docs.uniswap.org/contracts/v3/reference/core/interfaces/IUniswapV3Factory#getpool
            if (
                _poolKey(plan.tokenIn, first.tokenOut, first.fee)
                    == _poolKey(first.tokenOut, second.tokenOut, second.fee)
            ) {
                revert InvalidOperation(0, 1);
            }
        }
    }

    function _pullInput(IERC20 input, uint256 amountIn, uint256 entryInput) private {
        uint256 callerInput = input.balanceOf(msg.sender);
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        _requireBalance(input, address(this), entryInput + amountIn);
        _requireBalance(input, msg.sender, callerInput - amountIn);
    }

    function _swap(Operation calldata operation, SwapRequest memory request) private returns (uint256 amountOut) {
        IERC20 input = IERC20(request.tokenIn);
        input.forceApprove(uniswapRouter, request.amountIn);
        try IUniswapRouter02V2(uniswapRouter)
            .exactInputSingle(
                IUniswapRouter02V2.ExactInputSingleParams(
                    request.tokenIn,
                    operation.tokenOut,
                    operation.fee,
                    address(this),
                    request.amountIn,
                    request.minimum,
                    0
                )
            ) {}
        catch (bytes memory reason) {
            revert ProtocolCallFailed(0, request.operationIndex, reason);
        }
        input.forceApprove(uniswapRouter, 0);
        _requireBalance(input, address(this), request.entryInput);

        uint256 finalOutput = IERC20(operation.tokenOut).balanceOf(address(this));
        if (finalOutput <= request.entryOutput) revert OutputNotIncreased(0, request.operationIndex);
        return finalOutput - request.entryOutput;
    }

    function _poolKey(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(token0, token1, fee));
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
