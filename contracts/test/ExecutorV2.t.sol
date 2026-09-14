// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ExecutorV2, IUniswapRouter02V2} from "../src/ExecutorV2.sol";
import {TestToken} from "../src/TestToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ExecutorV2Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function expectRevert(bytes4 selector) external;
    function expectPartialRevert(bytes4 selector) external;
    function warp(uint256 timestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract ExecutorV2TaxToken is TestToken {
    address public taxedSender;

    constructor() TestToken("Tax", 18) {}

    function tax(address sender) external {
        taxedSender = sender;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && from == taxedSender && amount > 0) {
            super._update(from, address(0), 1);
            amount -= 1;
        }
        super._update(from, to, amount);
    }
}

contract ExecutorV2Router {
    uint256[2] public outputAmounts;
    uint256[2] public spendReductions;
    uint256[2] public reportedAmounts;
    uint256[2] public amountIns;
    uint256[2] public minimums;
    uint256 public lastMinimum;
    bytes public reentry;
    bool public reentryRejected;
    bool public sequential;
    uint256 public calls;

    constructor() {
        outputAmounts[0] = 137;
        reportedAmounts[0] = 999_999;
        reportedAmounts[1] = 999_999;
    }

    function configure(uint256 outputAmount_, uint256 spendReduction_) external {
        outputAmounts[0] = outputAmount_;
        spendReductions[0] = spendReduction_;
    }

    function configureCall(uint256 index, uint256 outputAmount, uint256 spendReduction, uint256 reportedAmount)
        external
    {
        outputAmounts[index] = outputAmount;
        spendReductions[index] = spendReduction;
        reportedAmounts[index] = reportedAmount;
        if (index == 1) sequential = true;
    }

    function setReentry(bytes calldata data) external {
        reentry = data;
    }

    function exactInputSingle(IUniswapRouter02V2.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256)
    {
        require(params.recipient == msg.sender && params.sqrtPriceLimitX96 == 0, "params");
        require(IERC20(params.tokenIn).allowance(msg.sender, address(this)) == params.amountIn, "allowance");
        uint256 index = sequential ? calls % 2 : 0;
        amountIns[index] = params.amountIn;
        minimums[index] = params.amountOutMinimum;
        lastMinimum = params.amountOutMinimum;
        if (reentry.length != 0) {
            (bool ok, bytes memory reason) = msg.sender.call(reentry);
            require(!ok && bytes4(reason) == ExecutorV2.ReentrantCall.selector, "reentry");
            reentryRejected = true;
        }
        calls = index + 1;
        uint256 spend = params.amountIn - spendReductions[index];
        require(IERC20(params.tokenIn).transferFrom(msg.sender, address(0xBEEF), spend), "input");
        require(IERC20(params.tokenOut).transfer(params.recipient, outputAmounts[index]), "output");
        return reportedAmounts[index]; // The executor must use the measured output instead.
    }
}

contract ExecutorV2Test {
    ExecutorV2Vm private constant vm = ExecutorV2Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    TestToken private tokenIn;
    TestToken private intermediate;
    TestToken private tokenOut;
    ExecutorV2Router private router;
    ExecutorV2 private executor;

    function setUp() public {
        tokenIn = new TestToken("Input", 18);
        intermediate = new TestToken("Intermediate", 18);
        tokenOut = new TestToken("Output", 6);
        router = new ExecutorV2Router();
        executor = new ExecutorV2(address(router));
        tokenIn.mint(address(this), 10_000);
        tokenIn.approve(address(executor), type(uint256).max);
        intermediate.mint(address(router), 10_000);
        tokenOut.mint(address(router), 10_000);
        vm.warp(1_000);
    }

    function plan(uint256 amount, uint256 branchMinimum, uint256 planMinimum, uint24 fee)
        private
        view
        returns (ExecutorV2.Plan memory result)
    {
        result.tokenIn = address(tokenIn);
        result.tokenOut = address(tokenOut);
        result.amountIn = amount;
        result.minAmountOut = planMinimum;
        result.deadline = 1_000;
        result.branches = new ExecutorV2.Branch[](1);
        result.branches[0].amountIn = amount;
        result.branches[0].minAmountOut = branchMinimum;
        result.branches[0].operations = new ExecutorV2.Operation[](1);
        result.branches[0].operations[0] = ExecutorV2.Operation(1, address(tokenOut), fee, 0, bytes32(0));
    }

    function twoHopPlan(uint256 amount, uint256 branchMinimum, uint256 planMinimum)
        private
        view
        returns (ExecutorV2.Plan memory result)
    {
        result = plan(amount, branchMinimum, planMinimum, 321);
        result.branches[0].operations = new ExecutorV2.Operation[](2);
        result.branches[0].operations[0] = ExecutorV2.Operation(1, address(intermediate), 321, 0, bytes32(0));
        result.branches[0].operations[1] = ExecutorV2.Operation(1, address(tokenOut), 322, 0, bytes32(0));
    }

    function splitPlan(uint256 firstMinimum, uint256 secondMinimum, uint256 planMinimum)
        private
        view
        returns (ExecutorV2.Plan memory result)
    {
        result = plan(37, firstMinimum, planMinimum, 500);
        result.branches = new ExecutorV2.Branch[](2);
        result.branches[0].amountIn = 13;
        result.branches[0].minAmountOut = firstMinimum;
        result.branches[0].operations = new ExecutorV2.Operation[](1);
        result.branches[0].operations[0] = ExecutorV2.Operation(1, address(tokenOut), 500, 0, bytes32(0));
        result.branches[1].amountIn = 24;
        result.branches[1].minAmountOut = secondMinimum;
        result.branches[1].operations = new ExecutorV2.Operation[](1);
        result.branches[1].operations[0] = ExecutorV2.Operation(1, address(tokenOut), 3000, 0, bytes32(0));
    }

    function execute(ExecutorV2.Plan memory value) private returns (uint256) {
        return executor.execute(value);
    }

    function callExecutor(bytes calldata data) external {
        (bool ok, bytes memory reason) = address(executor).call(data);
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function testCanonicalCommitmentMeasuredOutputEventsAllowanceAndDust() public {
        ExecutorV2.Plan memory value = plan(41, 136, 135, 321);
        tokenIn.mint(address(executor), 17);
        tokenOut.mint(address(executor), 23);
        tokenOut.mint(address(this), 29);
        bytes32 expected = keccak256(abi.encode(uint256(2), block.chainid, address(executor), address(this), value));

        vm.recordLogs();
        uint256 output = execute(value);
        require(output == 137 && router.lastMinimum() == 136, "output/minimum");
        require(tokenIn.balanceOf(address(executor)) == 17 && tokenOut.balanceOf(address(executor)) == 23, "dust");
        require(tokenOut.balanceOf(address(this)) == 166, "recipient");
        require(tokenIn.allowance(address(executor), address(router)) == 0, "allowance");

        ExecutorV2Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32[3] memory topics = [
            keccak256("OperationExecuted(bytes32,uint256,uint256,uint8,address,address,uint256,uint256)"),
            keccak256("BranchExecuted(bytes32,uint256,uint256,uint256)"),
            keccak256("PlanExecuted(bytes32,address,address,address,uint256,uint256)")
        ];
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(executor)) continue;
            require(found < 3 && logs[i].topics[0] == topics[found] && logs[i].topics[1] == expected, "events");
            ++found;
        }
        require(found == 3, "event count");
    }

    function testPublishedGenericPlanVector() public pure {
        ExecutorV2.Plan memory value;
        value.tokenIn = address(0x11);
        value.tokenOut = address(0x22);
        value.amountIn = 37;
        value.minAmountOut = 11;
        value.deadline = 2_000_000_000;
        value.branches = new ExecutorV2.Branch[](1);
        value.branches[0].amountIn = 37;
        value.branches[0].minAmountOut = 11;
        value.branches[0].operations = new ExecutorV2.Operation[](1);
        value.branches[0].operations[0] = ExecutorV2.Operation(1, address(0x22), 500, 0, bytes32(0));
        bytes memory data = abi.encodeWithSelector(ExecutorV2.execute.selector, value);
        require(bytes4(data) == 0x661983c5, "selector");
        require(keccak256(data) == 0x99d91872d777ea2defdeb91adb7b369142a8389a450fd1bdd1fea635dee669ce, "calldata");
        require(
            keccak256(abi.encode(uint256(2), uint256(8453), address(0x44), address(0x55), value))
                == 0x69c0ba7621841b73782fbd11f817d4b8fca74f7f5a24be110fdde434d174a6f5,
            "plan hash"
        );
    }

    function testPublishedTwoHopPlanVector() public pure {
        ExecutorV2.Plan memory value;
        value.tokenIn = address(0x11);
        value.tokenOut = address(0x33);
        value.amountIn = 37;
        value.minAmountOut = 11;
        value.deadline = 2_000_000_000;
        value.branches = new ExecutorV2.Branch[](1);
        value.branches[0].amountIn = 37;
        value.branches[0].minAmountOut = 11;
        value.branches[0].operations = new ExecutorV2.Operation[](2);
        value.branches[0].operations[0] = ExecutorV2.Operation(1, address(0x22), 500, 0, bytes32(0));
        value.branches[0].operations[1] = ExecutorV2.Operation(1, address(0x33), 3000, 0, bytes32(0));
        bytes memory data = abi.encodeWithSelector(ExecutorV2.execute.selector, value);
        require(keccak256(data) == 0xd2cacb1b926e613ad580853f4eee0fbb569001e432f716f99cf06ddc7cac8b9a, "calldata");
        require(
            keccak256(abi.encode(uint256(2), uint256(8453), address(0x44), address(0x55), value))
                == 0xc35a48eee0631dcbb1aea8df8504702345c36298f200668ce8db9c97f46f85b9,
            "plan hash"
        );
    }

    function testPublishedSplitPlanVector() public pure {
        ExecutorV2.Plan memory value;
        value.tokenIn = address(0x11);
        value.tokenOut = address(0x33);
        value.amountIn = 37;
        value.minAmountOut = 81;
        value.deadline = 2_000_000_000;
        value.branches = new ExecutorV2.Branch[](2);
        value.branches[0].amountIn = 13;
        value.branches[0].minAmountOut = 28;
        value.branches[0].operations = new ExecutorV2.Operation[](1);
        value.branches[0].operations[0] = ExecutorV2.Operation(1, address(0x33), 500, 0, bytes32(0));
        value.branches[1].amountIn = 24;
        value.branches[1].minAmountOut = 52;
        value.branches[1].operations = new ExecutorV2.Operation[](1);
        value.branches[1].operations[0] = ExecutorV2.Operation(1, address(0x33), 3000, 0, bytes32(0));
        bytes memory data = abi.encodeWithSelector(ExecutorV2.execute.selector, value);
        require(bytes4(data) == 0x661983c5, "selector");
        require(keccak256(data) == 0x7a5c7e47bb1732236201fe67f3bea58ff669dd5fcb73adb8ad857b4d00411366, "calldata");
        require(
            keccak256(abi.encode(uint256(2), uint256(8453), address(0x44), address(0x55), value))
                == 0x297bbd553b9c322ff5e3c5aaa88be7d24651e8f165d34b513407fffc648ffbf8,
            "plan hash"
        );
    }

    function testTwoHopUsesMeasuredIntermediateAndPreservesDust() public {
        ExecutorV2.Plan memory value = twoHopPlan(41, 60, 59);
        router.configureCall(0, 83, 0, 777);
        router.configureCall(1, 61, 0, 888);
        tokenIn.mint(address(executor), 17);
        intermediate.mint(address(executor), 23);
        tokenOut.mint(address(executor), 29);
        tokenOut.mint(address(this), 31);

        vm.recordLogs();
        require(execute(value) == 61, "final output");
        require(router.calls() == 2, "calls");
        require(router.amountIns(0) == 41 && router.amountIns(1) == 83, "measured chain");
        require(router.minimums(0) == 1 && router.minimums(1) == 60, "router minima");
        require(tokenIn.allowance(address(executor), address(router)) == 0, "input allowance");
        require(intermediate.allowance(address(executor), address(router)) == 0, "intermediate allowance");
        require(tokenIn.balanceOf(address(executor)) == 17, "input dust");
        require(intermediate.balanceOf(address(executor)) == 23, "intermediate dust");
        require(tokenOut.balanceOf(address(executor)) == 29, "output dust");
        require(tokenOut.balanceOf(address(this)) == 92, "recipient");

        ExecutorV2Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 operationTopic =
            keccak256("OperationExecuted(bytes32,uint256,uint256,uint8,address,address,uint256,uint256)");
        uint256 operationCount;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(executor) || logs[i].topics[0] != operationTopic) continue;
            (
                uint8 kind,
                address operationIn,
                address operationOut,
                uint256 operationAmountIn,
                uint256 operationAmountOut
            ) = abi.decode(logs[i].data, (uint8, address, address, uint256, uint256));
            require(kind == 1 && uint256(logs[i].topics[3]) == operationCount, "operation order");
            if (operationCount == 0) {
                require(
                    operationIn == address(tokenIn) && operationOut == address(intermediate) && operationAmountIn == 41
                        && operationAmountOut == 83,
                    "first event"
                );
            } else {
                require(
                    operationIn == address(intermediate) && operationOut == address(tokenOut) && operationAmountIn == 83
                        && operationAmountOut == 61,
                    "second event"
                );
            }
            ++operationCount;
        }
        require(operationCount == 2, "operation count");
    }

    function testTwoHopRejectsBrokenShapeAndReversePool() public {
        ExecutorV2.Plan memory value = twoHopPlan(41, 1, 1);
        value.branches[0].operations[1].tokenOut = address(intermediate);
        vm.expectPartialRevert(ExecutorV2.InvalidOperation.selector);
        execute(value);

        value = twoHopPlan(41, 1, 1);
        value.tokenOut = address(tokenIn);
        value.branches[0].operations[1] = ExecutorV2.Operation(1, address(tokenIn), 321, 0, bytes32(0));
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);
    }

    function testTwoHopZeroIntermediateAndPartialFinalSpendRollBack() public {
        ExecutorV2.Plan memory value = twoHopPlan(41, 1, 1);
        router.configureCall(0, 0, 0, 999);
        vm.expectPartialRevert(ExecutorV2.OutputNotIncreased.selector);
        execute(value);
        require(router.calls() == 0 && tokenIn.balanceOf(address(this)) == 10_000, "zero rollback");

        router.configureCall(0, 83, 0, 999);
        router.configureCall(1, 61, 1, 999);
        vm.expectPartialRevert(ExecutorV2.BalanceMismatch.selector);
        execute(value);
        require(router.calls() == 0 && tokenIn.balanceOf(address(this)) == 10_000, "partial rollback");
        require(tokenIn.allowance(address(executor), address(router)) == 0, "input rollback allowance");
        require(intermediate.allowance(address(executor), address(router)) == 0, "intermediate rollback allowance");
    }

    function testTwoHopFinalMinimumBoundaries() public {
        router.configureCall(0, 83, 0, 999);
        router.configureCall(1, 61, 0, 999);
        execute(twoHopPlan(41, 61, 61));

        router.configureCall(0, 83, 0, 999);
        router.configureCall(1, 61, 0, 999);
        vm.expectPartialRevert(ExecutorV2.BranchMinimumNotMet.selector);
        execute(twoHopPlan(41, 62, 1));

        router.configureCall(0, 83, 0, 999);
        router.configureCall(1, 61, 0, 999);
        vm.expectPartialRevert(ExecutorV2.PlanMinimumNotMet.selector);
        execute(twoHopPlan(41, 1, 62));
    }

    function testSplitSpendsLiteralAllocationsMeasuresEachBranchAndPreservesDust() public {
        ExecutorV2.Plan memory value = splitPlan(30, 56, 87);
        router.configureCall(0, 31, 0, 777);
        router.configureCall(1, 57, 0, 888);
        tokenIn.mint(address(executor), 17);
        tokenOut.mint(address(executor), 23);
        tokenOut.mint(address(this), 29);

        vm.recordLogs();
        require(execute(value) == 88, "aggregate output");
        require(router.amountIns(0) == 13 && router.amountIns(1) == 24, "literal allocations");
        require(router.minimums(0) == 30 && router.minimums(1) == 56, "branch minima");
        require(tokenIn.balanceOf(address(executor)) == 17 && tokenOut.balanceOf(address(executor)) == 23, "dust");
        require(tokenOut.balanceOf(address(this)) == 117, "payout");
        require(tokenIn.allowance(address(executor), address(router)) == 0, "allowance");

        ExecutorV2Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 operationTopic =
            keccak256("OperationExecuted(bytes32,uint256,uint256,uint8,address,address,uint256,uint256)");
        bytes32 branchTopic = keccak256("BranchExecuted(bytes32,uint256,uint256,uint256)");
        bytes32 planTopic = keccak256("PlanExecuted(bytes32,address,address,address,uint256,uint256)");
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(executor)) continue;
            bytes32 expectedTopic =
                found == 0 || found == 2 ? operationTopic : found == 1 || found == 3 ? branchTopic : planTopic;
            require(found < 5 && logs[i].topics[0] == expectedTopic, "event order");
            if (expectedTopic == operationTopic) {
                uint256 branchIndex = found / 2;
                (, address operationIn, address operationOut, uint256 operationAmountIn, uint256 operationAmountOut) =
                    abi.decode(logs[i].data, (uint8, address, address, uint256, uint256));
                require(uint256(logs[i].topics[2]) == branchIndex && uint256(logs[i].topics[3]) == 0, "operation index");
                require(
                    operationIn == address(tokenIn) && operationOut == address(tokenOut)
                        && operationAmountIn == (branchIndex == 0 ? 13 : 24)
                        && operationAmountOut == (branchIndex == 0 ? 31 : 57),
                    "operation values"
                );
            }
            ++found;
        }
        require(found == 5, "event count");
    }

    function testSplitMinimumsAreIndependent() public {
        router.configureCall(0, 31, 0, 999);
        router.configureCall(1, 57, 0, 999);
        execute(splitPlan(31, 57, 88));

        router.configureCall(0, 31, 0, 999);
        router.configureCall(1, 57, 0, 999);
        vm.expectPartialRevert(ExecutorV2.BranchMinimumNotMet.selector);
        execute(splitPlan(32, 1, 1));

        router.configureCall(0, 31, 0, 999);
        router.configureCall(1, 57, 0, 999);
        vm.expectPartialRevert(ExecutorV2.BranchMinimumNotMet.selector);
        execute(splitPlan(1, 58, 1));

        router.configureCall(0, 31, 0, 999);
        router.configureCall(1, 57, 0, 999);
        vm.expectPartialRevert(ExecutorV2.PlanMinimumNotMet.selector);
        execute(splitPlan(1, 1, 89));
    }

    function testSplitZeroOutputAndPartialSpendRollBackBothBranches() public {
        ExecutorV2.Plan memory value = splitPlan(1, 1, 1);
        router.configureCall(0, 0, 0, 999);
        router.configureCall(1, 57, 0, 999);
        vm.expectPartialRevert(ExecutorV2.OutputNotIncreased.selector);
        execute(value);
        require(router.calls() == 0 && tokenIn.balanceOf(address(this)) == 10_000, "first rollback");

        router.configureCall(0, 31, 0, 999);
        router.configureCall(1, 0, 0, 999);
        vm.expectPartialRevert(ExecutorV2.OutputNotIncreased.selector);
        execute(value);
        require(router.calls() == 0 && tokenIn.balanceOf(address(this)) == 10_000, "second zero rollback");

        router.configureCall(0, 31, 0, 999);
        router.configureCall(1, 57, 1, 999);
        vm.expectPartialRevert(ExecutorV2.BalanceMismatch.selector);
        execute(value);
        require(router.calls() == 0 && tokenIn.balanceOf(address(this)) == 10_000, "second rollback");

        router.configureCall(0, 31, 1, 999);
        router.configureCall(1, 57, 0, 999);
        vm.expectPartialRevert(ExecutorV2.BalanceMismatch.selector);
        execute(value);
        require(router.calls() == 0 && tokenIn.balanceOf(address(this)) == 10_000, "first partial rollback");
        require(tokenIn.allowance(address(executor), address(router)) == 0, "rollback allowance");
    }

    function testSplitRejectsAllocationTotalsDuplicatePoolAndTwoByTwo() public {
        ExecutorV2.Plan memory value = splitPlan(1, 1, 1);
        value.branches[1].amountIn = 23;
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);

        value = splitPlan(1, 1, 1);
        value.branches[1].amountIn = 25;
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);

        value = splitPlan(1, 1, 1);
        value.branches[1].operations[0].fee = 500;
        vm.expectPartialRevert(ExecutorV2.InvalidOperation.selector);
        execute(value);

        value = splitPlan(1, 1, 1);
        value.branches[1].operations = new ExecutorV2.Operation[](2);
        value.branches[1].operations[0] = ExecutorV2.Operation(1, address(intermediate), 3000, 0, bytes32(0));
        value.branches[1].operations[1] = ExecutorV2.Operation(1, address(tokenOut), 3001, 0, bytes32(0));
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);
    }

    function testRejectsNonCanonicalTrailingWord() public {
        bytes memory data = bytes.concat(abi.encodeCall(executor.execute, (plan(41, 1, 1, 321))), bytes32(0));
        vm.expectRevert(ExecutorV2.NonCanonicalEncoding.selector);
        this.callExecutor(data);
    }

    function testFeeZeroIsRepresentable() public {
        require(execute(plan(41, 137, 137, 0)) == 137);
    }

    function testBranchAndAggregateMinimumBoundaries() public {
        execute(plan(41, 137, 137, 321));
        vm.expectPartialRevert(ExecutorV2.BranchMinimumNotMet.selector);
        execute(plan(41, 138, 1, 321));
        vm.expectPartialRevert(ExecutorV2.PlanMinimumNotMet.selector);
        execute(plan(41, 1, 138, 321));
    }

    function testRejectsUnsupportedAndNonzeroInactiveFields() public {
        ExecutorV2.Plan memory value = plan(41, 1, 1, 321);
        value.branches[0].operations[0].kind = 2;
        vm.expectPartialRevert(ExecutorV2.UnsupportedKind.selector);
        execute(value);

        value = plan(41, 1, 1, 321);
        value.branches[0].operations[0].tickSpacing = 1;
        vm.expectPartialRevert(ExecutorV2.InvalidOperation.selector);
        execute(value);

        value = plan(41, 1, 1, 321);
        value.branches[0].operations[0].poolId = bytes32(uint256(1));
        vm.expectPartialRevert(ExecutorV2.InvalidOperation.selector);
        execute(value);
    }

    function testPartialSpendRollsBackEverything() public {
        router.configure(137, 1);
        uint256 callerBefore = tokenIn.balanceOf(address(this));
        vm.expectPartialRevert(ExecutorV2.BalanceMismatch.selector);
        execute(plan(41, 1, 1, 321));
        require(tokenIn.balanceOf(address(this)) == callerBefore, "caller rollback");
        require(router.calls() == 0 && tokenIn.allowance(address(executor), address(router)) == 0, "rollback");
    }

    function testTaxedCallerCreditRevertsAndRollsBack() public {
        ExecutorV2TaxToken taxed = new ExecutorV2TaxToken();
        taxed.mint(address(router), 1_000);
        taxed.tax(address(executor));
        ExecutorV2.Plan memory value = plan(41, 1, 1, 321);
        value.tokenOut = address(taxed);
        value.branches[0].operations[0].tokenOut = address(taxed);
        vm.expectPartialRevert(ExecutorV2.BalanceMismatch.selector);
        executor.execute(value);
        require(taxed.balanceOf(address(this)) == 0 && tokenIn.balanceOf(address(this)) == 10_000, "rollback");
    }

    function testDeadlineEqualityAndExpiry() public {
        execute(plan(41, 1, 1, 321));
        vm.warp(1_001);
        vm.expectPartialRevert(ExecutorV2.Expired.selector);
        execute(plan(41, 1, 1, 321));
    }

    function testShapeAndMinimumRejections() public {
        ExecutorV2.Plan memory value = plan(41, 1, 1, 321);
        value.branches = new ExecutorV2.Branch[](0);
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);

        value = plan(40, 1, 1, 321);
        value.branches[0].amountIn = 41;
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);

        value = plan(41, 0, 1, 321);
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);

        value = plan(41, 1, 0, 321);
        vm.expectRevert(ExecutorV2.InvalidPlan.selector);
        execute(value);
    }

    function testConstructorRejectsAddressWithoutCode() public {
        vm.expectRevert(ExecutorV2.InvalidDeployment.selector);
        new ExecutorV2(address(0xBEEF));
    }

    function testReentrancyRejected() public {
        ExecutorV2.Plan memory value = plan(41, 1, 1, 321);
        router.setReentry(abi.encodeCall(executor.execute, (value)));
        execute(value);
        require(router.reentryRejected(), "guard");
    }
}
