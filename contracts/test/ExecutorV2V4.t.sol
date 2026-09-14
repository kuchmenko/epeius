// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ExecutorV2} from "../src/ExecutorV2.sol";
import {TestToken} from "../src/TestToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ExecutorV2V4Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function expectRevert(bytes4 selector) external;
    function expectPartialRevert(bytes4 selector) external;
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract ExecutorV2V4PoolManager {}

contract ExecutorV2V4OutputSource {
    function send(address token, address recipient, uint256 amount) external {
        require(IERC20(token).transfer(recipient, amount), "output");
    }
}

contract ExecutorV2Permit2 {
    struct Permission {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Permission))) public permissions;
    bool public leaveOne;
    bool public malformed;

    function setLeaveOne(bool value) external {
        leaveOne = value;
    }

    function setMalformed(bool value) external {
        malformed = value;
    }

    function setPermission(address owner, address token, address spender, uint160 amount, uint48 expiration) external {
        permissions[owner][token][spender] = Permission(amount, expiration, 7);
    }

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce)
    {
        if (malformed) {
            assembly {
                return(0, 32)
            }
        }
        Permission memory value = permissions[owner][token][spender];
        return (value.amount, value.expiration, value.nonce);
    }

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        Permission storage value = permissions[msg.sender][token][spender];
        value.amount = amount;
        value.expiration = expiration;
    }

    function spend(address owner, address token, address to, uint160 amount) external {
        Permission storage value = permissions[owner][token][msg.sender];
        uint160 spendAmount = leaveOne ? amount - 1 : amount;
        require(value.amount >= spendAmount && value.expiration >= block.timestamp, "permission");
        value.amount -= spendAmount;
        require(IERC20(token).transferFrom(owner, to, spendAmount), "transfer");
    }
}

contract ExecutorV2UniversalRouter {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInput {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    address public poolManager;
    ExecutorV2Permit2 public immutable permit;
    ExecutorV2V4OutputSource public immutable outputSource;
    uint256 public outputAmount = 137;
    bool public wrongReturn;
    bool public leaveResidue;
    bytes public lastCommands;
    bytes public lastActions;
    uint256 public lastDeadline;
    ExactInput public lastSwap;
    address public lastSettleToken;
    uint256 public lastSettleAmount;
    bool public lastPayerIsUser;
    address public lastTakeToken;
    uint256 public lastTakeMinimum;
    bytes32 public lastCallHash;

    constructor(address manager, ExecutorV2Permit2 permit_, ExecutorV2V4OutputSource outputSource_) {
        poolManager = manager;
        permit = permit_;
        outputSource = outputSource_;
    }

    function setPoolManager(address value) external {
        poolManager = value;
    }

    function configure(uint256 output, bool returnWord, bool residue) external {
        outputAmount = output;
        wrongReturn = returnWord;
        leaveResidue = residue;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        lastCallHash = keccak256(msg.data);
        require(msg.value == 0 && commands.length == 1 && commands[0] == 0x10 && inputs.length == 1, "commands");
        lastCommands = commands;
        lastDeadline = deadline;
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(keccak256(actions) == keccak256(hex"060b0f") && params.length == 3, "actions");
        lastActions = actions;
        lastSwap = abi.decode(params[0], (ExactInput));
        (lastSettleToken, lastSettleAmount, lastPayerIsUser) = abi.decode(params[1], (address, uint256, bool));
        (lastTakeToken, lastTakeMinimum) = abi.decode(params[2], (address, uint256));
        require(lastSwap.hookData.length == 0, "hook data");
        require(lastSettleAmount == lastSwap.amountIn && lastPayerIsUser, "settle");
        permit.spend(msg.sender, lastSettleToken, address(0xBEEF), uint160(lastSettleAmount));
        outputSource.send(lastTakeToken, msg.sender, outputAmount);
        if (leaveResidue) require(IERC20(lastSettleToken).transferFrom(msg.sender, address(this), 1), "residue");
        if (wrongReturn) {
            assembly {
                mstore(0, 1)
                return(0, 32)
            }
        }
    }
}

contract ExecutorV2MalformedManagerRouter {
    fallback() external {
        assembly {
            return(0, 0)
        }
    }
}

contract ExecutorV2NoncanonicalManagerRouter {
    fallback() external {
        assembly {
            mstore(0, not(0))
            return(0, 32)
        }
    }
}

contract ExecutorV2V4Test {
    ExecutorV2V4Vm private constant vm = ExecutorV2V4Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    TestToken private tokenIn;
    TestToken private tokenOut;
    ExecutorV2V4PoolManager private manager;
    ExecutorV2Permit2 private permit;
    ExecutorV2V4OutputSource private outputSource;
    ExecutorV2UniversalRouter private router;
    ExecutorV2 private executor;

    function setUp() public {
        tokenIn = new TestToken("Input", 18);
        tokenOut = new TestToken("Output", 6);
        manager = new ExecutorV2V4PoolManager();
        permit = new ExecutorV2Permit2();
        outputSource = new ExecutorV2V4OutputSource();
        router = new ExecutorV2UniversalRouter(address(manager), permit, outputSource);
        executor = deploy(address(router), address(permit), address(manager));
        tokenIn.mint(address(this), 10_000);
        tokenOut.mint(address(outputSource), 10_000);
        tokenIn.approve(address(executor), type(uint256).max);
        vm.warp(1_000);
    }

    function deploy(address universal, address permitAddress, address managerAddress) private returns (ExecutorV2) {
        return new ExecutorV2(
            address(0), address(0), address(0), address(0), universal, permitAddress, managerAddress, new bytes32[](0)
        );
    }

    function plan(uint256 amount, uint256 minimum, uint24 fee, int24 spacing)
        private
        view
        returns (ExecutorV2.Plan memory value)
    {
        value = ExecutorV2.Plan(address(tokenIn), address(tokenOut), amount, minimum, 1_000, new ExecutorV2.Branch[](1));
        value.branches[0] = ExecutorV2.Branch(amount, minimum, new ExecutorV2.Operation[](1));
        value.branches[0].operations[0] = ExecutorV2.Operation(5, address(tokenOut), fee, spacing, bytes32(0));
    }

    function testExactV4CallMeasuredOutputAndPermissionCleanup() public {
        tokenIn.mint(address(executor), 17);
        tokenOut.mint(address(executor), 23);
        vm.recordLogs();
        uint256 output = executor.execute(plan(41, 136, 500, 10));
        require(output == 137, "measured output");
        require(router.lastCommands().length == 1 && router.lastCommands()[0] == 0x10, "command");
        require(keccak256(router.lastActions()) == keccak256(hex"060b0f"), "actions");
        require(router.lastDeadline() == 1_000 && router.lastSettleAmount() == 41, "amount/deadline");
        require(router.lastPayerIsUser() && router.lastTakeMinimum() == 136, "settle/take");
        (uint160 amount, uint48 expiration, uint48 nonce) =
            permit.allowance(address(executor), address(tokenIn), address(router));
        require(amount == 0 && expiration == 1_000 && nonce == 0, "Permit2 cleanup");
        require(tokenIn.allowance(address(executor), address(permit)) == 0, "ERC20 cleanup");
        require(tokenIn.balanceOf(address(executor)) == 17 && tokenOut.balanceOf(address(executor)) == 23, "dust");
        ExecutorV2V4Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 operationTopic =
            keccak256("OperationExecuted(bytes32,uint256,uint256,uint8,address,address,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(executor) || logs[i].topics[0] != operationTopic) continue;
            (uint8 kind, address input, address resultToken, uint256 spent, uint256 measured) =
                abi.decode(logs[i].data, (uint8, address, address, uint256, uint256));
            require(
                kind == 5 && input == address(tokenIn) && resultToken == address(tokenOut) && spent == 41
                    && measured == 137,
                "operation event"
            );
            return;
        }
        revert("missing operation event");
    }

    function testIndependentV4IdentityAndRouterCalldataVectors() public {
        address input = 0x1111111111111111111111111111111111111111;
        address output = 0x9999999999999999999999999999999999999999;
        address configuredManager = 0x6666666666666666666666666666666666666666;
        bytes32 providerHash = keccak256(
            abi.encode(
                keccak256("Epeius.AtomicProvider.v1"),
                uint8(5),
                configuredManager,
                input,
                output,
                uint24(1_000_000),
                int24(32_767),
                address(0)
            )
        );
        require(providerHash == 0xc57657ca7195ff4e9db177d33dabe251e81a7e9c2f686039d31e4c81940f9235, "provider vector");
        require(
            keccak256(abi.encode(input, output, uint24(1_000_000), int24(32_767), address(0)))
                == 0x9f4a0d8a2b781dcb932a2044b79fbd8c6bb1f4fd0e905f71a648d879b0cf6b84,
            "pool vector"
        );

        router.configure(1_111_111, false, false);
        tokenIn.mint(address(this), 1_234_567);
        tokenOut.mint(address(outputSource), 1_111_111);
        executor.execute(plan(1_234_567, 1_000_000, 1_000_000, 32_767));
        (address currency0, address currency1) = address(tokenIn) < address(tokenOut)
            ? (address(tokenIn), address(tokenOut))
            : (address(tokenOut), address(tokenIn));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExecutorV2UniversalRouter.ExactInput(
                ExecutorV2UniversalRouter.PoolKey(currency0, currency1, 1_000_000, 32_767, address(0)),
                address(tokenIn) == currency0,
                1_234_567,
                1_000_000,
                hex""
            )
        );
        params[1] = abi.encode(address(tokenIn), uint256(1_234_567), true);
        params[2] = abi.encode(address(tokenOut), uint256(1_000_000));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060b0f", params);
        require(
            router.lastCallHash() == keccak256(abi.encodeWithSelector(0x3593564c, hex"10", inputs, 1_000)),
            "router calldata"
        );
    }

    function testConstructorRequiresCompleteDistinctLinkedV4Triple() public {
        vm.expectRevert(ExecutorV2.InvalidDeployment.selector);
        deploy(address(router), address(0), address(manager));
        vm.expectRevert(ExecutorV2.InvalidDeployment.selector);
        deploy(address(router), address(permit), address(router));
        router.setPoolManager(address(0xBEEF));
        vm.expectRevert(ExecutorV2.InvalidDeployment.selector);
        deploy(address(router), address(permit), address(manager));
        ExecutorV2MalformedManagerRouter malformed = new ExecutorV2MalformedManagerRouter();
        vm.expectRevert(ExecutorV2.InvalidDeployment.selector);
        deploy(address(malformed), address(permit), address(manager));
        ExecutorV2NoncanonicalManagerRouter noncanonical = new ExecutorV2NoncanonicalManagerRouter();
        vm.expectRevert(ExecutorV2.InvalidDeployment.selector);
        deploy(address(noncanonical), address(permit), address(manager));
    }

    function testDisabledKindFailsBeforeFunding() public {
        ExecutorV2 disabled = new ExecutorV2(
            address(new ExecutorV2MalformedManagerRouter()),
            address(0),
            address(0),
            address(0),
            address(0),
            address(0),
            address(0),
            new bytes32[](0)
        );
        tokenIn.approve(address(disabled), 41);
        uint256 before = tokenIn.balanceOf(address(this));
        vm.expectPartialRevert(ExecutorV2.UnsupportedKind.selector);
        disabled.execute(plan(41, 1, 500, 10));
        require(tokenIn.balanceOf(address(this)) == before, "funded");
    }

    function testSelectorAndAmountBoundaries() public {
        executor.execute(plan(41, 1, 1_000_000, 32_767));
        vm.expectPartialRevert(ExecutorV2.InvalidOperation.selector);
        executor.execute(plan(41, 1, 1_000_001, 10));
        for (int24 spacing = 0; spacing <= 32_768; spacing += 32_768) {
            vm.expectPartialRevert(ExecutorV2.InvalidOperation.selector);
            executor.execute(plan(41, 1, 500, spacing));
        }
        vm.expectPartialRevert(ExecutorV2.AmountOutOfRange.selector);
        executor.execute(plan(uint256(type(uint128).max) + 1, 1, 500, 10));
        vm.expectPartialRevert(ExecutorV2.AmountOutOfRange.selector);
        executor.execute(plan(41, uint256(type(uint128).max) + 1, 500, 10));
        ExecutorV2.Plan memory inactive = plan(41, 1, 500, 10);
        inactive.branches[0].operations[0].poolId = bytes32(uint256(1));
        vm.expectPartialRevert(ExecutorV2.InvalidOperation.selector);
        executor.execute(inactive);
    }

    function testReversePoolReuseRejected() public {
        ExecutorV2.Plan memory value = plan(41, 1, 500, 10);
        value.branches[0].operations = new ExecutorV2.Operation[](2);
        value.branches[0].operations[0] = ExecutorV2.Operation(5, address(tokenOut), 500, 10, bytes32(0));
        value.branches[0].operations[1] = ExecutorV2.Operation(5, address(tokenIn), 500, 10, bytes32(0));
        value.tokenOut = address(tokenIn);
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        executor.execute(value);
    }

    function testRejectsInitialPermissionsAndMalformedRead() public {
        vm.prank(address(executor));
        tokenIn.approve(address(permit), 1);
        vm.expectPartialRevert(ExecutorV2.AllowanceMismatch.selector);
        executor.execute(plan(41, 1, 500, 10));
        vm.prank(address(executor));
        tokenIn.approve(address(permit), 0);
        permit.setPermission(address(executor), address(tokenIn), address(router), 1, 999);
        vm.expectPartialRevert(ExecutorV2.Permit2Mismatch.selector);
        executor.execute(plan(41, 1, 500, 10));
        permit.setPermission(address(executor), address(tokenIn), address(router), 0, 999);
        executor.execute(plan(41, 1, 500, 10));
        permit.setPermission(address(executor), address(tokenIn), address(router), 0, 999);
        permit.setMalformed(true);
        vm.expectPartialRevert(ExecutorV2.PermissionCallFailed.selector);
        executor.execute(plan(41, 1, 500, 10));
    }

    function testPartialPermit2ConsumptionWrongReturnAndResidueRollback() public {
        permit.setLeaveOne(true);
        vm.expectPartialRevert(ExecutorV2.Permit2Mismatch.selector);
        executor.execute(plan(41, 1, 500, 10));
        require(tokenIn.balanceOf(address(this)) == 10_000, "partial rollback");
        permit.setLeaveOne(false);
        router.configure(137, true, false);
        vm.expectPartialRevert(ExecutorV2.ProtocolCallFailed.selector);
        executor.execute(plan(41, 1, 500, 10));
        router.configure(137, false, true);
        vm.expectPartialRevert(ExecutorV2.ProtocolCallFailed.selector);
        executor.execute(plan(41, 1, 500, 10));
    }

    function testZeroOutputRejectedAndPoolManagerReserveMayChange() public {
        router.configure(0, false, false);
        vm.expectPartialRevert(ExecutorV2.OutputNotIncreased.selector);
        executor.execute(plan(41, 1, 1_000_000, 10));
        tokenIn.mint(address(manager), 1);
        router.configure(137, false, false);
        executor.execute(plan(41, 1, 500, 10));
        require(tokenIn.balanceOf(address(manager)) == 1, "manager reserve checked");
    }
}
