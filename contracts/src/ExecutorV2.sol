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

interface IUniversalRouterV2 {
    function poolManager() external view returns (address);
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2V2 {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
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

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct V4ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    struct V4Baselines {
        uint256 routerInput;
        uint256 routerOutput;
        uint256 permitInput;
        uint256 permitOutput;
        uint256 routerNative;
        uint256 permitNative;
    }

    uint8 private constant UNISWAP_V3 = 1;
    uint8 private constant PANCAKE_V3 = 2;
    uint8 private constant SLIPSTREAM_INITIAL = 3;
    uint8 private constant BALANCER_V2 = 4;
    uint8 private constant UNISWAP_V4 = 5;

    address public immutable uniswapRouter;
    address public immutable pancakeRouter;
    address public immutable slipstreamRouter;
    address public immutable balancerVault;
    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable poolManager;
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
    error TokenCallFailed(address token, bytes4 selector);
    error PermissionCallFailed(bytes4 selector);
    error AllowanceMismatch(address token, address spender, uint256 expected, uint256 actual);
    error Permit2Mismatch(
        address token, uint160 expectedAmount, uint160 actualAmount, uint48 expectedExpiration, uint48 actualExpiration
    );

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
        address universalRouter_,
        address permit2_,
        address poolManager_,
        bytes32[] memory balancerPoolIds_
    ) {
        bool balancerEnabled = balancerPoolIds_.length != 0;
        bool v4Enabled = universalRouter_ != address(0) || permit2_ != address(0) || poolManager_ != address(0);
        if (
            (uniswapRouter_ == address(0)
                    && pancakeRouter_ == address(0)
                    && slipstreamRouter_ == address(0)
                    && !balancerEnabled
                    && !v4Enabled) || (uniswapRouter_ != address(0) && uniswapRouter_.code.length == 0)
                || (pancakeRouter_ != address(0) && pancakeRouter_.code.length == 0)
                || (slipstreamRouter_ != address(0) && slipstreamRouter_.code.length == 0)
                || (balancerEnabled != (balancerVault_ != address(0)))
                || (balancerVault_ != address(0) && balancerVault_.code.length == 0)
                || (v4Enabled
                    && (universalRouter_ == address(0)
                        || permit2_ == address(0)
                        || poolManager_ == address(0)
                        || universalRouter_.code.length == 0
                        || permit2_.code.length == 0
                        || poolManager_.code.length == 0))
                || (uniswapRouter_ != address(0) && uniswapRouter_ == pancakeRouter_)
                || (uniswapRouter_ != address(0) && uniswapRouter_ == slipstreamRouter_)
                || (pancakeRouter_ != address(0) && pancakeRouter_ == slipstreamRouter_)
                || (balancerVault_ != address(0)
                    && (balancerVault_ == uniswapRouter_
                        || balancerVault_ == pancakeRouter_
                        || balancerVault_ == slipstreamRouter_))
                || _hasEndpointAlias(
                    uniswapRouter_,
                    pancakeRouter_,
                    slipstreamRouter_,
                    balancerVault_,
                    universalRouter_,
                    permit2_,
                    poolManager_
                )
        ) revert InvalidDeployment();
        uniswapRouter = uniswapRouter_;
        pancakeRouter = pancakeRouter_;
        slipstreamRouter = slipstreamRouter_;
        balancerVault = balancerVault_;
        universalRouter = universalRouter_;
        permit2 = permit2_;
        poolManager = poolManager_;
        if (v4Enabled) {
            (bool ok, bytes memory result) =
                universalRouter_.staticcall(abi.encodeCall(IUniversalRouterV2.poolManager, ()));
            uint256 managerWord;
            if (result.length == 32) {
                assembly {
                    managerWord := mload(add(result, 32))
                }
            }
            if (
                !ok || result.length != 32 || managerWord > type(uint160).max
                    || address(uint160(managerWord)) != poolManager_
            ) {
                revert InvalidDeployment();
            }
        }
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
                } else if (operation.kind == UNISWAP_V4) {
                    if (universalRouter == address(0)) revert UnsupportedKind(operation.kind);
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
                } else if (operation.kind == UNISWAP_V4) {
                    invalidSelector =
                        operation.fee > 1_000_000 || operation.tickSpacing <= 0 || operation.tickSpacing > 32_767;
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
                    : operation.kind == UNISWAP_V4
                        ? _v4PoolId(currentToken, operation.tokenOut, operation.fee, operation.tickSpacing)
                        : _poolKey(
                            operation.kind, currentToken, operation.tokenOut, operation.fee, operation.tickSpacing
                        );
                if (branchIndex == 0 && operationIndex == 0) firstPool = pool;
                else if (pool == firstPool) revert InvalidOperation(branchIndex, operationIndex);
                if (operation.kind == UNISWAP_V4) {
                    if (block.timestamp > type(uint48).max) revert InvalidPlan();
                    uint256 knownAmount = operationIndex == 0 ? branch.amountIn : 0;
                    uint256 knownMinimum = operationIndex + 1 == branch.operations.length ? branch.minAmountOut : 1;
                    if (knownAmount > type(uint128).max) {
                        revert AmountOutOfRange(branchIndex, operationIndex, knownAmount, type(uint128).max);
                    }
                    if (knownMinimum > type(uint128).max) {
                        revert AmountOutOfRange(branchIndex, operationIndex, knownMinimum, type(uint128).max);
                    }
                    uint256 allowance = _tokenAllowance(currentToken, address(this), permit2);
                    if (allowance != 0) revert AllowanceMismatch(currentToken, permit2, 0, allowance);
                    (uint160 amount, uint48 expiration,) = _permit2Allowance(currentToken);
                    if (amount != 0) revert Permit2Mismatch(currentToken, 0, amount, expiration, expiration);
                }
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
        uint256 maximum = operation.kind == BALANCER_V2
            ? type(uint256).max - 1
            : operation.kind == UNISWAP_V4 ? type(uint128).max : uint256(type(int256).max);
        if (request.amountIn > maximum) {
            revert AmountOutOfRange(branchIndex, request.operationIndex, request.amountIn, maximum);
        }
        if (operation.kind == UNISWAP_V4 && request.minimum > type(uint128).max) {
            revert AmountOutOfRange(branchIndex, request.operationIndex, request.minimum, type(uint128).max);
        }
        IERC20 input = IERC20(request.tokenIn);
        address router = operation.kind == UNISWAP_V3
            ? uniswapRouter
            : operation.kind == PANCAKE_V3
                ? pancakeRouter
                : operation.kind == SLIPSTREAM_INITIAL
                    ? slipstreamRouter
                    : operation.kind == BALANCER_V2 ? balancerVault : universalRouter;
        if (operation.kind == UNISWAP_V4) {
            return _swapV4(operation, request, branchIndex);
        }
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

    function _swapV4(Operation calldata operation, SwapRequest memory request, uint256 branchIndex)
        private
        returns (uint256 amountOut)
    {
        IERC20 input = IERC20(request.tokenIn);
        IERC20 output = IERC20(operation.tokenOut);
        V4Baselines memory baseline = V4Baselines(
            input.balanceOf(universalRouter),
            output.balanceOf(universalRouter),
            input.balanceOf(permit2),
            output.balanceOf(permit2),
            universalRouter.balance,
            permit2.balance
        );
        uint48 expiration = uint48(block.timestamp);

        input.forceApprove(permit2, request.amountIn);
        uint256 allowance = _tokenAllowance(request.tokenIn, address(this), permit2);
        if (allowance != request.amountIn) {
            revert AllowanceMismatch(request.tokenIn, permit2, request.amountIn, allowance);
        }
        _permit2Approve(request.tokenIn, uint160(request.amountIn), expiration);
        _requirePermit2(request.tokenIn, uint160(request.amountIn), expiration);

        (bool ok, bytes memory result) = universalRouter.call(_v4CallData(operation, request));
        if (!ok || result.length != 0) revert ProtocolCallFailed(branchIndex, request.operationIndex, result);

        _requirePermit2(request.tokenIn, 0, expiration);
        _permit2Approve(request.tokenIn, 0, expiration);
        _requirePermit2(request.tokenIn, 0, expiration);
        input.forceApprove(permit2, 0);
        allowance = _tokenAllowance(request.tokenIn, address(this), permit2);
        if (allowance != 0) revert AllowanceMismatch(request.tokenIn, permit2, 0, allowance);
        _requireBalance(input, address(this), request.entryInput);

        uint256 finalOutput = output.balanceOf(address(this));
        if (finalOutput <= request.entryOutput) revert OutputNotIncreased(branchIndex, request.operationIndex);
        _requireBalance(input, universalRouter, baseline.routerInput);
        _requireBalance(output, universalRouter, baseline.routerOutput);
        _requireBalance(input, permit2, baseline.permitInput);
        _requireBalance(output, permit2, baseline.permitOutput);
        if (universalRouter.balance != baseline.routerNative) {
            revert BalanceMismatch(address(0), universalRouter, baseline.routerNative, universalRouter.balance);
        }
        if (permit2.balance != baseline.permitNative) {
            revert BalanceMismatch(address(0), permit2, baseline.permitNative, permit2.balance);
        }
        if (address(this).balance < request.entryNative) {
            revert BalanceMismatch(address(0), address(this), request.entryNative, address(this).balance);
        }
        return finalOutput - request.entryOutput;
    }

    function _v4CallData(Operation calldata operation, SwapRequest memory request) private view returns (bytes memory) {
        (address currency0, address currency1) = request.tokenIn < operation.tokenOut
            ? (request.tokenIn, operation.tokenOut)
            : (operation.tokenOut, request.tokenIn);
        PoolKey memory key = PoolKey(currency0, currency1, operation.fee, operation.tickSpacing, address(0));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            V4ExactInputSingleParams(
                key, request.tokenIn == currency0, uint128(request.amountIn), uint128(request.minimum), hex""
            )
        );
        params[1] = abi.encode(request.tokenIn, request.amountIn, true);
        params[2] = abi.encode(operation.tokenOut, request.minimum);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060b0f", params);
        return abi.encodeCall(IUniversalRouterV2.execute, (hex"10", inputs, request.deadline));
    }

    function _permit2Approve(address token, uint160 amount, uint48 expiration) private {
        (bool ok, bytes memory result) =
            permit2.call(abi.encodeCall(IPermit2V2.approve, (token, universalRouter, amount, expiration)));
        if (!ok || result.length != 0) revert PermissionCallFailed(IPermit2V2.approve.selector);
    }

    function _permit2Allowance(address token) private view returns (uint160 amount, uint48 expiration, uint48 nonce) {
        (bool ok, bytes memory result) =
            permit2.staticcall(abi.encodeCall(IPermit2V2.allowance, (address(this), token, universalRouter)));
        if (!ok || result.length != 96) revert PermissionCallFailed(IPermit2V2.allowance.selector);
        uint256 rawAmount;
        uint256 rawExpiration;
        uint256 rawNonce;
        assembly {
            rawAmount := mload(add(result, 32))
            rawExpiration := mload(add(result, 64))
            rawNonce := mload(add(result, 96))
        }
        if (rawAmount > type(uint160).max || rawExpiration > type(uint48).max || rawNonce > type(uint48).max) {
            revert PermissionCallFailed(IPermit2V2.allowance.selector);
        }
        return (uint160(rawAmount), uint48(rawExpiration), uint48(rawNonce));
    }

    function _requirePermit2(address token, uint160 expectedAmount, uint48 expectedExpiration) private view {
        (uint160 amount, uint48 expiration,) = _permit2Allowance(token);
        if (amount != expectedAmount || expiration != expectedExpiration) {
            revert Permit2Mismatch(token, expectedAmount, amount, expectedExpiration, expiration);
        }
    }

    function _tokenAllowance(address token, address owner, address spender) private view returns (uint256 allowance) {
        (bool ok, bytes memory result) = token.staticcall(abi.encodeCall(IERC20.allowance, (owner, spender)));
        if (!ok || result.length != 32) revert TokenCallFailed(token, IERC20.allowance.selector);
        allowance = abi.decode(result, (uint256));
    }

    function _poolKey(uint8 kind, address tokenA, address tokenB, uint24 fee, int24 tickSpacing)
        private
        pure
        returns (bytes32)
    {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(kind, token0, token1, fee, tickSpacing));
    }

    function _v4PoolId(address tokenA, address tokenB, uint24 fee, int24 tickSpacing) private pure returns (bytes32) {
        (address currency0, address currency1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(currency0, currency1, fee, tickSpacing, address(0)));
    }

    function _hasEndpointAlias(address a, address b, address c, address d, address e, address f, address g)
        private
        pure
        returns (bool)
    {
        address[7] memory endpoints = [a, b, c, d, e, f, g];
        for (uint256 i; i < endpoints.length; ++i) {
            if (endpoints[i] == address(0)) continue;
            for (uint256 j = i + 1; j < endpoints.length; ++j) {
                if (endpoints[i] == endpoints[j]) return true;
            }
        }
        return false;
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
