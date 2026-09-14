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

interface IPancakeRouterV2 {
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

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Executes one V3 branch of up to two operations or two direct V3 branches.
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
        uint256 deadline;
    }

    uint8 private constant UNISWAP_V3 = 1;
    uint8 private constant PANCAKE_V3 = 2;

    address public immutable uniswapRouter;
    address public immutable pancakeRouter;
    bool private entered;

    error ReentrantCall();
    error NonCanonicalEncoding();
    error Expired(uint256 deadline, uint256 timestamp);
    error InvalidPlan();
    error UnsupportedKind(uint8 kind);
    error InvalidOperation(uint256 branchIndex, uint256 operationIndex);
    error AmountOutOfRange(uint256 branchIndex, uint256 operationIndex, uint256 amount, uint256 maximum);
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

    constructor(address uniswapRouter_, address pancakeRouter_) {
        if (
            (uniswapRouter_ == address(0) && pancakeRouter_ == address(0))
                || (uniswapRouter_ != address(0) && uniswapRouter_.code.length == 0)
                || (pancakeRouter_ != address(0) && pancakeRouter_.code.length == 0)
                || (uniswapRouter_ != address(0) && uniswapRouter_ == pancakeRouter_)
        ) revert InvalidDeployment();
        uniswapRouter = uniswapRouter_;
        pancakeRouter = pancakeRouter_;
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
        IERC20 input = IERC20(plan.tokenIn);
        IERC20 output = IERC20(plan.tokenOut);
        uint256 entryInput = input.balanceOf(address(this));
        uint256 entryOutput = output.balanceOf(address(this));
        uint256 entryIntermediate;
        if (plan.branches[0].operations.length == 2) {
            entryIntermediate = IERC20(plan.branches[0].operations[0].tokenOut).balanceOf(address(this));
        }

        _pullInput(input, plan.amountIn, entryInput);
        amountOut = _executeBranches(planHash, plan, entryInput, entryIntermediate, entryOutput);
        _requireBalance(output, address(this), entryOutput + amountOut);
        if (amountOut < plan.minAmountOut) revert PlanMinimumNotMet(plan.minAmountOut, amountOut);

        _payOutput(output, amountOut);
        _requireBalance(input, address(this), entryInput);
        if (plan.branches[0].operations.length == 2) {
            _requireBalance(IERC20(plan.branches[0].operations[0].tokenOut), address(this), entryIntermediate);
        }
        _requireBalance(output, address(this), entryOutput);
        emit PlanExecuted(planHash, msg.sender, plan.tokenOut, plan.tokenIn, plan.amountIn, amountOut);
    }

    function _executeBranches(
        bytes32 planHash,
        Plan calldata plan,
        uint256 entryInput,
        uint256 entryIntermediate,
        uint256 entryOutput
    ) private returns (uint256 amountOut) {
        uint256 remainingInput = plan.amountIn;
        for (uint256 i; i < plan.branches.length; ++i) {
            Branch calldata branch = plan.branches[i];
            remainingInput -= branch.amountIn;
            uint256 branchOutput = _executeBranch(
                planHash, branch, i, plan, entryInput + remainingInput, entryIntermediate, entryOutput + amountOut
            );
            if (branchOutput < branch.minAmountOut) {
                revert BranchMinimumNotMet(i, branch.minAmountOut, branchOutput);
            }
            amountOut += branchOutput;
            emit BranchExecuted(planHash, i, branch.amountIn, branchOutput);
        }
    }

    function _executeBranch(
        bytes32 planHash,
        Branch calldata branch,
        uint256 branchIndex,
        Plan calldata plan,
        uint256 entryInput,
        uint256 entryIntermediate,
        uint256 entryOutput
    ) private returns (uint256 amountOut) {
        address currentToken = plan.tokenIn;
        uint256 currentAmount = branch.amountIn;
        for (uint256 i; i < branch.operations.length; ++i) {
            Operation calldata operation = branch.operations[i];
            bool finalOperation = i + 1 == branch.operations.length;
            SwapRequest memory request = SwapRequest(
                currentToken,
                currentAmount,
                finalOperation ? branch.minAmountOut : 1,
                i == 0 ? entryInput : entryIntermediate,
                finalOperation ? entryOutput : entryIntermediate,
                i,
                plan.deadline
            );
            amountOut = _swap(operation, request, branchIndex);
            _emitOperation(planHash, branchIndex, i, operation, currentToken, currentAmount, amountOut);
            currentToken = operation.tokenOut;
            currentAmount = amountOut;
        }
    }

    function _emitOperation(
        bytes32 planHash,
        uint256 branchIndex,
        uint256 operationIndex,
        Operation calldata operation,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    ) private {
        emit OperationExecuted(
            planHash, branchIndex, operationIndex, operation.kind, tokenIn, operation.tokenOut, amountIn, amountOut
        );
    }

    function _validate(Plan calldata plan) private view {
        if (
            plan.tokenIn == address(0) || plan.tokenOut == address(0) || plan.tokenIn == plan.tokenOut
                || plan.tokenIn == address(this) || plan.tokenOut == address(this) || plan.tokenIn.code.length == 0
                || plan.tokenOut.code.length == 0 || plan.amountIn == 0 || plan.minAmountOut == 0
                || plan.branches.length == 0 || plan.branches.length > 2
        ) revert InvalidPlan();

        uint256 totalInput;
        bytes32 firstPool;
        for (uint256 branchIndex; branchIndex < plan.branches.length; ++branchIndex) {
            Branch calldata branch = plan.branches[branchIndex];
            if (
                branch.amountIn == 0 || branch.minAmountOut == 0 || branch.operations.length == 0
                    || branch.operations.length > 2 || (plan.branches.length == 2 && branch.operations.length != 1)
            ) revert InvalidPlan();
            totalInput += branch.amountIn;

            address currentToken = plan.tokenIn;
            for (uint256 operationIndex; operationIndex < branch.operations.length; ++operationIndex) {
                Operation calldata operation = branch.operations[operationIndex];
                if (operation.kind == UNISWAP_V3) {
                    if (uniswapRouter == address(0)) revert UnsupportedKind(operation.kind);
                } else if (operation.kind == PANCAKE_V3) {
                    if (pancakeRouter == address(0)) revert UnsupportedKind(operation.kind);
                } else {
                    revert UnsupportedKind(operation.kind);
                }
                if (
                    operation.tokenOut == currentToken || operation.tokenOut.code.length == 0
                        || operation.fee >= 1_000_000 || operation.tickSpacing != 0 || operation.poolId != bytes32(0)
                ) revert InvalidOperation(branchIndex, operationIndex);
                bytes32 pool = _poolKey(operation.kind, currentToken, operation.tokenOut, operation.fee);
                if (branchIndex == 0 && operationIndex == 0) firstPool = pool;
                else if (pool == firstPool) revert InvalidOperation(branchIndex, operationIndex);
                currentToken = operation.tokenOut;
            }
            if (currentToken != plan.tokenOut) {
                revert InvalidOperation(branchIndex, branch.operations.length - 1);
            }
        }
        if (totalInput != plan.amountIn) revert InvalidPlan();
    }

    function _pullInput(IERC20 input, uint256 amountIn, uint256 entryInput) private {
        uint256 callerInput = input.balanceOf(msg.sender);
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        _requireBalance(input, address(this), entryInput + amountIn);
        _requireBalance(input, msg.sender, callerInput - amountIn);
    }

    function _swap(Operation calldata operation, SwapRequest memory request, uint256 branchIndex)
        private
        returns (uint256 amountOut)
    {
        if (request.amountIn > uint256(type(int256).max)) {
            revert AmountOutOfRange(branchIndex, request.operationIndex, request.amountIn, uint256(type(int256).max));
        }
        IERC20 input = IERC20(request.tokenIn);
        address router = operation.kind == UNISWAP_V3 ? uniswapRouter : pancakeRouter;
        input.forceApprove(router, request.amountIn);
        if (operation.kind == UNISWAP_V3) {
            try IUniswapRouter02V2(router)
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
                revert ProtocolCallFailed(branchIndex, request.operationIndex, reason);
            }
        } else {
            try IPancakeRouterV2(router)
                .exactInputSingle(
                    IPancakeRouterV2.ExactInputSingleParams(
                        request.tokenIn,
                        operation.tokenOut,
                        operation.fee,
                        address(this),
                        request.deadline,
                        request.amountIn,
                        request.minimum,
                        0
                    )
                ) {}
            catch (bytes memory reason) {
                revert ProtocolCallFailed(branchIndex, request.operationIndex, reason);
            }
        }
        input.forceApprove(router, 0);
        _requireBalance(input, address(this), request.entryInput);

        uint256 finalOutput = IERC20(operation.tokenOut).balanceOf(address(this));
        if (finalOutput <= request.entryOutput) revert OutputNotIncreased(branchIndex, request.operationIndex);
        return finalOutput - request.entryOutput;
    }

    function _poolKey(uint8 kind, address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(kind, token0, token1, fee));
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
