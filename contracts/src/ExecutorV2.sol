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

interface ISlipstreamRouterV2 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IBalancerVaultV2 {
    enum SwapKind {
        GIVEN_IN,
        GIVEN_OUT
    }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }

    function getPool(bytes32 poolId) external view returns (address pool, uint8 specialization);
    function swap(SingleSwap calldata singleSwap, FundManagement calldata funds, uint256 limit, uint256 deadline)
        external
        payable
        returns (uint256 amountCalculated);
}

interface IBalancerPoolV2 {
    function getPoolId() external view returns (bytes32);
}

/// @notice Executes one branch of up to two operations or two direct branches.
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
        uint256 entryNative;
    }

    struct EntryBalances {
        uint256 input;
        uint256 intermediate;
        uint256 output;
        uint256 nativeBalance;
        uint256 callerInput;
        uint256 callerIntermediate;
        uint256 callerOutput;
    }

    uint8 private constant UNISWAP_V3 = 1;
    uint8 private constant PANCAKE_V3 = 2;
    uint8 private constant SLIPSTREAM_INITIAL = 3;
    uint8 private constant BALANCER_V2 = 4;

    address public immutable uniswapRouter;
    address public immutable pancakeRouter;
    address public immutable slipstreamRouter;
    address public immutable balancerVault;
    bytes32 public immutable balancerPoolsHash;
    mapping(bytes32 => bool) private allowedBalancerPools;
    bool private entered;
    bool private slipstreamCallActive;

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
    error UnexpectedNativeSender(address sender);
    error NativeRefundFailed(address caller, uint256 amount);
    error InvalidDeployment();
    error PoolNotAllowed(bytes32 poolId);

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
    event NativeRefunded(bytes32 indexed planHash, address indexed caller, uint256 amount);
    event PlanExecuted(
        bytes32 indexed planHash,
        address indexed caller,
        address indexed tokenOut,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        address uniswapRouter_,
        address pancakeRouter_,
        address slipstreamRouter_,
        address balancerVault_,
        bytes32[] memory balancerPoolIds_
    ) {
        bool balancerEnabled = balancerPoolIds_.length != 0;
        if (
            (uniswapRouter_ == address(0)
                    && pancakeRouter_ == address(0)
                    && slipstreamRouter_ == address(0)
                    && !balancerEnabled) || (uniswapRouter_ != address(0) && uniswapRouter_.code.length == 0)
                || (pancakeRouter_ != address(0) && pancakeRouter_.code.length == 0)
                || (slipstreamRouter_ != address(0) && slipstreamRouter_.code.length == 0)
                || (balancerEnabled != (balancerVault_ != address(0)))
                || (balancerVault_ != address(0) && balancerVault_.code.length == 0)
                || (uniswapRouter_ != address(0) && uniswapRouter_ == pancakeRouter_)
                || (uniswapRouter_ != address(0) && uniswapRouter_ == slipstreamRouter_)
                || (pancakeRouter_ != address(0) && pancakeRouter_ == slipstreamRouter_)
                || (balancerVault_ != address(0)
                    && (balancerVault_ == uniswapRouter_
                        || balancerVault_ == pancakeRouter_
                        || balancerVault_ == slipstreamRouter_))
        ) revert InvalidDeployment();
        uniswapRouter = uniswapRouter_;
        pancakeRouter = pancakeRouter_;
        slipstreamRouter = slipstreamRouter_;
        balancerVault = balancerVault_;
        balancerPoolsHash = keccak256(abi.encode(balancerPoolIds_));
        bytes32 previous;
        for (uint256 i; i < balancerPoolIds_.length; ++i) {
            bytes32 poolId = balancerPoolIds_[i];
            if (poolId == bytes32(0) || (i != 0 && uint256(poolId) <= uint256(previous))) {
                revert InvalidDeployment();
            }
            address pool = _getBalancerPool(balancerVault_, poolId);
            if (pool == address(0) || pool.code.length == 0) revert InvalidDeployment();
            (bool ok, bytes memory result) = pool.staticcall(abi.encodeCall(IBalancerPoolV2.getPoolId, ()));
            if (!ok || result.length != 32 || abi.decode(result, (bytes32)) != poolId) revert InvalidDeployment();
            allowedBalancerPools[poolId] = true;
            previous = poolId;
        }
    }

    /// @dev Slipstream Initial refunds the router's native balance to its direct caller after a swap.
    /// See https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/SwapRouter.sol.
    receive() external payable {
        if (!entered || !slipstreamCallActive || msg.sender != slipstreamRouter) {
            revert UnexpectedNativeSender(msg.sender);
        }
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

    function isBalancerPoolAllowed(bytes32 poolId) external view returns (bool) {
        return allowedBalancerPools[poolId];
    }

    function execute(Plan calldata plan) external nonReentrant returns (uint256 amountOut) {
        if (keccak256(msg.data[4:]) != keccak256(abi.encode(plan))) revert NonCanonicalEncoding();
        if (block.timestamp > plan.deadline) revert Expired(plan.deadline, block.timestamp);
        _validate(plan);

        bytes32 planHash = keccak256(abi.encode(uint256(2), block.chainid, address(this), msg.sender, plan));
        IERC20 input = IERC20(plan.tokenIn);
        IERC20 output = IERC20(plan.tokenOut);
        EntryBalances memory entry = EntryBalances({
            input: input.balanceOf(address(this)),
            intermediate: 0,
            output: output.balanceOf(address(this)),
            nativeBalance: address(this).balance,
            callerInput: input.balanceOf(msg.sender),
            callerIntermediate: 0,
            callerOutput: output.balanceOf(msg.sender)
        });
        if (plan.branches[0].operations.length == 2) {
            entry.intermediate = IERC20(plan.branches[0].operations[0].tokenOut).balanceOf(address(this));
            entry.callerIntermediate = IERC20(plan.branches[0].operations[0].tokenOut).balanceOf(msg.sender);
        }

        _pullInput(input, plan.amountIn, entry.input);
        amountOut = _executeBranches(planHash, plan, entry.input, entry.intermediate, entry.output, entry.nativeBalance);
        _requireBalance(output, address(this), entry.output + amountOut);
        if (amountOut < plan.minAmountOut) revert PlanMinimumNotMet(plan.minAmountOut, amountOut);

        _payOutput(output, amountOut);
        _requireBalance(input, address(this), entry.input);
        if (plan.branches[0].operations.length == 2) {
            _requireBalance(IERC20(plan.branches[0].operations[0].tokenOut), address(this), entry.intermediate);
        }
        _requireBalance(output, address(this), entry.output);
        _refundNative(planHash, plan, entry, amountOut);
        emit PlanExecuted(planHash, msg.sender, plan.tokenOut, plan.tokenIn, plan.amountIn, amountOut);
    }

    function _executeBranches(
        bytes32 planHash,
        Plan calldata plan,
        uint256 entryInput,
        uint256 entryIntermediate,
        uint256 entryOutput,
        uint256 entryNative
    ) private returns (uint256 amountOut) {
        uint256 remainingInput = plan.amountIn;
        for (uint256 i; i < plan.branches.length; ++i) {
            Branch calldata branch = plan.branches[i];
            remainingInput -= branch.amountIn;
            uint256 branchOutput = _executeBranch(
                planHash,
                branch,
                i,
                plan,
                entryInput + remainingInput,
                entryIntermediate,
                entryOutput + amountOut,
                entryNative
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
        uint256 entryOutput,
        uint256 entryNative
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
                plan.deadline,
                entryNative
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
                } else if (operation.kind == SLIPSTREAM_INITIAL) {
                    if (slipstreamRouter == address(0)) revert UnsupportedKind(operation.kind);
                } else if (operation.kind == BALANCER_V2) {
                    if (balancerVault == address(0)) revert UnsupportedKind(operation.kind);
                } else {
                    revert UnsupportedKind(operation.kind);
                }
                bool invalidSelector;
                if (operation.kind == SLIPSTREAM_INITIAL) {
                    invalidSelector = operation.fee != 0 || operation.tickSpacing <= 0;
                } else if (operation.kind == BALANCER_V2) {
                    invalidSelector = operation.fee != 0 || operation.tickSpacing != 0 || operation.poolId == bytes32(0);
                    if (!invalidSelector && !allowedBalancerPools[operation.poolId]) {
                        revert PoolNotAllowed(operation.poolId);
                    }
                } else {
                    invalidSelector = operation.fee >= 1_000_000 || operation.tickSpacing != 0;
                }
                if (
                    operation.tokenOut == currentToken || operation.tokenOut.code.length == 0 || invalidSelector
                        || (operation.kind != BALANCER_V2 && operation.poolId != bytes32(0))
                ) revert InvalidOperation(branchIndex, operationIndex);
                if (operation.kind == BALANCER_V2) {
                    address bpt = _getBalancerPool(balancerVault, operation.poolId);
                    if (bpt == address(0) || bpt.code.length == 0 || currentToken == bpt || operation.tokenOut == bpt) {
                        revert InvalidOperation(branchIndex, operationIndex);
                    }
                }
                bytes32 pool = operation.kind == BALANCER_V2
                    ? keccak256(abi.encode(operation.kind, operation.poolId))
                    : _poolKey(operation.kind, currentToken, operation.tokenOut, operation.fee, operation.tickSpacing);
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
        uint256 maximum = operation.kind == BALANCER_V2 ? type(uint256).max - 1 : uint256(type(int256).max);
        if (request.amountIn > maximum) {
            revert AmountOutOfRange(branchIndex, request.operationIndex, request.amountIn, maximum);
        }
        IERC20 input = IERC20(request.tokenIn);
        address router = operation.kind == UNISWAP_V3
            ? uniswapRouter
            : operation.kind == PANCAKE_V3
                ? pancakeRouter
                : operation.kind == SLIPSTREAM_INITIAL ? slipstreamRouter : balancerVault;
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
        } else if (operation.kind == PANCAKE_V3) {
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
        } else if (operation.kind == SLIPSTREAM_INITIAL) {
            slipstreamCallActive = true;
            try ISlipstreamRouterV2(router)
                .exactInputSingle(
                    ISlipstreamRouterV2.ExactInputSingleParams(
                        request.tokenIn,
                        operation.tokenOut,
                        operation.tickSpacing,
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
            slipstreamCallActive = false;
        } else {
            try IBalancerVaultV2(router)
                .swap(
                    IBalancerVaultV2.SingleSwap(
                        operation.poolId,
                        IBalancerVaultV2.SwapKind.GIVEN_IN,
                        request.tokenIn,
                        operation.tokenOut,
                        request.amountIn,
                        hex""
                    ),
                    IBalancerVaultV2.FundManagement(address(this), false, payable(address(this)), false),
                    request.minimum,
                    request.deadline
                ) {}
            catch (bytes memory reason) {
                revert ProtocolCallFailed(branchIndex, request.operationIndex, reason);
            }
        }
        input.forceApprove(router, 0);
        _requireBalance(input, address(this), request.entryInput);

        uint256 finalOutput = IERC20(operation.tokenOut).balanceOf(address(this));
        if (finalOutput <= request.entryOutput) revert OutputNotIncreased(branchIndex, request.operationIndex);
        if (address(this).balance < request.entryNative) {
            revert BalanceMismatch(address(0), address(this), request.entryNative, address(this).balance);
        }
        return finalOutput - request.entryOutput;
    }

    function _poolKey(uint8 kind, address tokenA, address tokenB, uint24 fee, int24 tickSpacing)
        private
        pure
        returns (bytes32)
    {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(kind, token0, token1, fee, tickSpacing));
    }

    function _getBalancerPool(address vault, bytes32 poolId) private view returns (address pool) {
        (bool ok, bytes memory result) = vault.staticcall(abi.encodeCall(IBalancerVaultV2.getPool, (poolId)));
        if (!ok || result.length != 64) return address(0);
        uint256 poolWord;
        uint256 specialization;
        assembly {
            poolWord := mload(add(result, 32))
            specialization := mload(add(result, 64))
        }
        if (poolWord > type(uint160).max || specialization > 2) return address(0);
        return address(uint160(poolWord));
    }

    function _refundNative(bytes32 planHash, Plan calldata plan, EntryBalances memory entry, uint256 amountOut)
        private
    {
        // Return only value introduced during this execution; pre-existing executor value is never sweepable.
        if (address(this).balance < entry.nativeBalance) {
            revert BalanceMismatch(address(0), address(this), entry.nativeBalance, address(this).balance);
        }
        uint256 amount = address(this).balance - entry.nativeBalance;
        if (amount != 0) {
            (bool ok,) = msg.sender.call{value: amount}(hex"");
            if (!ok) revert NativeRefundFailed(msg.sender, amount);
        }
        _requireBalance(IERC20(plan.tokenIn), address(this), entry.input);
        _requireBalance(IERC20(plan.tokenIn), msg.sender, entry.callerInput - plan.amountIn);
        if (plan.branches[0].operations.length == 2) {
            _requireBalance(IERC20(plan.branches[0].operations[0].tokenOut), address(this), entry.intermediate);
            _requireBalance(IERC20(plan.branches[0].operations[0].tokenOut), msg.sender, entry.callerIntermediate);
        }
        _requireBalance(IERC20(plan.tokenOut), address(this), entry.output);
        _requireBalance(IERC20(plan.tokenOut), msg.sender, entry.callerOutput + amountOut);
        if (address(this).balance != entry.nativeBalance) {
            revert BalanceMismatch(address(0), address(this), entry.nativeBalance, address(this).balance);
        }
        if (amount != 0) emit NativeRefunded(planHash, msg.sender, amount);
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
