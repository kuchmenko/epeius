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
    uint256 public outputAmount = 137;
    uint256 public spendReduction;
    uint256 public lastMinimum;
    bytes public reentry;
    bool public reentryRejected;
    uint256 public calls;

    function configure(uint256 outputAmount_, uint256 spendReduction_) external {
        outputAmount = outputAmount_;
        spendReduction = spendReduction_;
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
        lastMinimum = params.amountOutMinimum;
        if (reentry.length != 0) {
            (bool ok, bytes memory reason) = msg.sender.call(reentry);
            require(!ok && bytes4(reason) == ExecutorV2.ReentrantCall.selector, "reentry");
            reentryRejected = true;
        }
        ++calls;
        uint256 spend = params.amountIn - spendReduction;
        require(IERC20(params.tokenIn).transferFrom(msg.sender, address(0xBEEF), spend), "input");
        require(IERC20(params.tokenOut).transfer(params.recipient, outputAmount), "output");
        return 999_999; // The executor must use the measured output instead.
    }
}

contract ExecutorV2Test {
    ExecutorV2Vm private constant vm = ExecutorV2Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    TestToken private tokenIn;
    TestToken private tokenOut;
    ExecutorV2Router private router;
    ExecutorV2 private executor;

    function setUp() public {
        tokenIn = new TestToken("Input", 18);
        tokenOut = new TestToken("Output", 6);
        router = new ExecutorV2Router();
        executor = new ExecutorV2(address(router));
        tokenIn.mint(address(this), 10_000);
        tokenIn.approve(address(executor), type(uint256).max);
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
