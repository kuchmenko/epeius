// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Executor, IUniswapRouter02, IPancakeRouter} from "../src/Executor.sol";
import {TestToken} from "../src/TestToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ExecutorVm {
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function warp(uint256) external;
    function prank(address) external;
}

// Unsupported token behaviors are used only to test accounting checks and the reentrancy guard.
contract CallbackToken is TestToken {
    address public taxedSender;
    address public callbackSender;
    address public target;
    bytes public data;
    bool public rejected;

    constructor() TestToken("Callback", 18) {}

    function tax(address sender) external {
        taxedSender = sender;
    }

    function callback(address sender, address target_, bytes calldata data_) external {
        callbackSender = sender;
        target = target_;
        data = data_;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && from == callbackSender) {
            (bool ok, bytes memory reason) = target.call(data);
            require(!ok && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "guard missing");
            rejected = true;
        }
        if (from != address(0) && from == taxedSender && amount != 0) {
            super._update(from, address(0), 1);
            amount -= 1;
        }
        super._update(from, to, amount);
    }
}

// Deliberately reports a false return amount. The executor must use balances instead.
contract RecordingRouter {
    mapping(address => uint256) public output;
    mapping(address => uint256) public spent;
    mapping(address => uint256) public requested;
    address public partialToken;
    address public failingToken;
    bytes public reentry;
    bool public reentryRejected;

    function configure(address token, uint256 amount) external {
        output[token] = amount;
    }

    function setPartial(address token) external {
        partialToken = token;
    }

    function fail(address token) external {
        failingToken = token;
    }

    function reenter(bytes calldata data) external {
        reentry = data;
    }

    function exactInputSingle(IUniswapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(p.sqrtPriceLimitX96 == 0 && p.amountOutMinimum == 0, "hidden hop floor");
        return swap(p.tokenIn, p.tokenOut, p.recipient, p.amountIn);
    }

    function exactInputSingle(IPancakeRouter.ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(p.deadline >= block.timestamp, "router expired");
        require(p.sqrtPriceLimitX96 == 0 && p.amountOutMinimum == 0, "hidden hop floor");
        return swap(p.tokenIn, p.tokenOut, p.recipient, p.amountIn);
    }

    function swap(address input, address out, address recipient, uint256 amount) private returns (uint256) {
        require(amount > 0 && recipient == msg.sender, "payer/recipient");
        require(input != failingToken, "second venue failed");
        require(IERC20(input).allowance(msg.sender, address(this)) == amount, "not exact approval");
        if (reentry.length != 0) {
            (bool ok, bytes memory reason) = msg.sender.call(reentry);
            require(!ok && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "guard missing");
            reentryRejected = true;
        }
        requested[input] = amount;
        uint256 consumed = input == partialToken ? amount - 1 : amount;
        spent[input] += consumed;
        // Use a separate sink so pre-existing router dust is observable and stays unchanged.
        require(IERC20(input).transferFrom(msg.sender, address(0xBEEF), consumed));
        require(IERC20(out).transfer(recipient, output[input]));
        return 80;
    }
}

contract ExecutorTest {
    ExecutorVm constant vm = ExecutorVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestToken a;
    TestToken b;
    TestToken c;
    RecordingRouter uni;
    RecordingRouter pancake;
    Executor executor;

    function setUp() public {
        a = new TestToken("A", 18);
        b = new TestToken("B", 6);
        c = new TestToken("C", 8);
        uni = new RecordingRouter();
        pancake = new RecordingRouter();
        executor = new Executor(address(uni), address(pancake));
        a.mint(address(this), 1e30);
        a.approve(address(executor), type(uint256).max);
        b.mint(address(uni), 1e30);
        b.mint(address(pancake), 1e30);
        c.mint(address(uni), 1e30);
        c.mint(address(pancake), 1e30);
        uni.configure(address(a), 101);
        pancake.configure(address(a), 99);
        uni.configure(address(b), 117);
        pancake.configure(address(b), 83);
        vm.warp(1000);
    }

    function route(uint8 venue, uint256 amount, bool twoHop) internal view returns (Executor.Allocation memory r) {
        r.venue = venue;
        r.amountIn = amount;
        r.hops = new Executor.Hop[](twoHop ? 2 : 1);
        r.hops[0] = Executor.Hop(twoHop ? address(b) : address(c), 0);
        if (twoHop) r.hops[1] = Executor.Hop(address(c), 2500);
    }

    function split(bool twoHop) internal view returns (Executor.Allocation[] memory r) {
        r = new Executor.Allocation[](2);
        r[0] = route(0, 37, twoHop);
        r[1] = route(1, 64, twoHop);
    }

    function run(Executor.Allocation[] memory r, uint256 total, uint256 minimum) internal returns (uint256) {
        return executor.execute(address(a), address(c), total, minimum, 1000, r);
    }

    function clean() internal view {
        require(a.allowance(address(executor), address(uni)) == 0, "uni input allowance");
        require(a.allowance(address(executor), address(pancake)) == 0, "pancake input allowance");
        require(b.allowance(address(executor), address(uni)) == 0, "uni intermediate allowance");
        require(b.allowance(address(executor), address(pancake)) == 0, "pancake intermediate allowance");
    }

    function testSplit37And64ExactSpendAggregateAndDust() public {
        a.mint(address(executor), 7);
        b.mint(address(executor), 11);
        c.mint(address(executor), 13);
        a.mint(address(uni), 17);
        a.mint(address(pancake), 19);
        uint256 caller = a.balanceOf(address(this));
        require(run(split(false), 101, 199) == 200, "aggregate output");
        require(a.balanceOf(address(this)) == caller - 101 && c.balanceOf(address(this)) == 200, "caller deltas");
        require(uni.spent(address(a)) == 37 && pancake.spent(address(a)) == 64, "allocation amounts");
        require(
            a.balanceOf(address(executor)) == 7 && b.balanceOf(address(executor)) == 11
                && c.balanceOf(address(executor)) == 13,
            "executor dust"
        );
        require(a.balanceOf(address(uni)) == 17 && a.balanceOf(address(pancake)) == 19, "router input dust");
        clean();
    }

    function testActualOutput81NotReturn80OrDustFeedsNextHop() public {
        uni.configure(address(a), 81);
        b.mint(address(executor), 10000);
        Executor.Allocation[] memory r = new Executor.Allocation[](1);
        r[0] = route(0, 37, true);
        require(run(r, 37, 117) == 117);
        require(uni.requested(address(b)) == 81 && uni.spent(address(b)) == 81, "not actual output");
        require(b.balanceOf(address(executor)) == 10000, "spent prior intermediate");
        clean();
    }

    function testSharedIntermediateDoesNotSubsidizeOtherRoute() public {
        b.mint(address(executor), 23);
        require(run(split(true), 101, 200) == 200);
        require(uni.requested(address(b)) == 101 && pancake.requested(address(b)) == 99, "route output mixed");
        require(b.balanceOf(address(executor)) == 23, "shared dust");
        clean();
    }

    function testAggregateBoundaryDoesNotRoundPerAllocation() public {
        // 101 + 99, aggregate 50 bps minimum = floor(200 * 9950 / 10000) = 199.
        // Separately rounded floors would accept 198. No per-route floors exist in the ABI.
        uni.configure(address(a), 100);
        pancake.configure(address(a), 98);
        vm.expectRevert(Executor.InsufficientOutput.selector);
        run(split(false), 101, 199);
        pancake.configure(address(a), 99);
        require(run(split(false), 101, 199) == 199, "minimum equality");
    }

    function testMinZeroAllowedAndMinPlusOneReverts() public {
        vm.expectRevert(Executor.InsufficientOutput.selector);
        run(split(false), 101, 201);
        require(run(split(false), 101, 0) == 200);
    }

    function testDeadlineEqualityAndExpired() public {
        vm.warp(1001);
        vm.expectRevert(Executor.Expired.selector);
        run(split(false), 101, 0);
        vm.warp(1000);
        require(run(split(false), 101, 200) == 200);
    }

    function testPartialFirstHopRevertsDespiteEnoughOutput() public {
        uni.setPartial(address(a));
        vm.expectRevert(Executor.IncompleteSpend.selector);
        run(split(false), 101, 1);
        require(uni.spent(address(a)) == 0 && c.balanceOf(address(this)) == 0, "rollback");
        clean();
    }

    function testPartialSecondHopRevertsDespiteEnoughOutput() public {
        pancake.setPartial(address(b));
        vm.expectRevert(Executor.IncompleteSpend.selector);
        run(split(true), 101, 1);
        require(uni.spent(address(a)) == 0 && pancake.spent(address(a)) == 0, "earlier hop rollback");
        clean();
    }

    function testSecondVenueFailureRollsBackFirstAndCaller() public {
        pancake.fail(address(a));
        uint256 beforeA = a.balanceOf(address(this));
        vm.expectRevert();
        run(split(false), 101, 1);
        require(a.balanceOf(address(this)) == beforeA && c.balanceOf(address(this)) == 0);
        require(uni.spent(address(a)) == 0 && a.balanceOf(address(0xBEEF)) == 0, "router state rollback");
        clean();
    }

    function testZeroActualIntermediateCannotTriggerRouterSentinel() public {
        uni.configure(address(a), 0);
        b.mint(address(executor), 91);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(split(true), 101, 0);
        require(b.balanceOf(address(executor)) == 91);
    }

    function testRejectAmountsAndOverflowBeforePull() public {
        Executor.Allocation[] memory r = split(false);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 100, 0);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 102, 0);
        r[0].amountIn = 0;
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 64, 0);
        r[0].amountIn = type(uint256).max;
        r[1].amountIn = 1;
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, type(uint256).max, 0);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 0, 0);
    }

    function testRejectMalformedPathsAndVenues() public {
        Executor.Allocation[] memory r = split(true);
        r[1].venue = 0;
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r[1].venue = 2;
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r[1].venue = 1;
        r[0].hops[0].tokenOut = address(a);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r[0].hops[0].tokenOut = address(c);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r[0].hops[0].tokenOut = address(b);
        r[0].hops[1].tokenOut = address(a);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r[0].hops[1].tokenOut = address(b);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r[0].hops = new Executor.Hop[](0);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r[0].hops = new Executor.Hop[](3);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r = new Executor.Allocation[](0);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
        r = new Executor.Allocation[](3);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
    }

    function testRejectNonContractAndIdenticalEndpointsAndRouters() public {
        vm.expectRevert(Executor.InvalidPlan.selector);
        new Executor(address(uni), address(uni));
        vm.expectRevert(Executor.InvalidPlan.selector);
        new Executor(address(0), address(pancake));
        Executor.Allocation[] memory r = split(false);
        vm.expectRevert(Executor.InvalidPlan.selector);
        executor.execute(address(a), address(a), 101, 0, 1000, r);
        vm.expectRevert(Executor.InvalidPlan.selector);
        executor.execute(address(0), address(c), 101, 0, 1000, r);
        r[0].hops[0].tokenOut = address(7);
        vm.expectRevert(Executor.InvalidPlan.selector);
        run(r, 101, 0);
    }

    function testReentrancyDuringRouterCallRejected() public {
        uni.reenter(abi.encodeCall(executor.execute, (address(a), address(c), 101, 0, 1000, split(false))));
        require(run(split(false), 101, 200) == 200);
        require(uni.reentryRejected(), "no reentry attempt");
        clean();
    }

    function testCallerCannotSpendOtherWalletApproval() public {
        vm.prank(address(9));
        vm.expectRevert();
        executor.execute(address(a), address(c), 101, 0, 1000, split(false));
        require(a.balanceOf(address(this)) == 1e30, "other wallet spent");
    }

    function testFourthTouchedTokenAndReversedVenueOrder() public {
        TestToken d = new TestToken("D", 12);
        d.mint(address(pancake), 1000);
        d.mint(address(executor), 29);
        b.mint(address(executor), 23);
        pancake.configure(address(d), 97);
        Executor.Allocation[] memory r = split(true);
        r[1].hops[0].tokenOut = address(d);
        Executor.Allocation memory first = r[0];
        r[0] = r[1];
        r[1] = first;
        require(run(r, 101, 214) == 214);
        require(d.balanceOf(address(executor)) == 29 && b.balanceOf(address(executor)) == 23);
        require(pancake.requested(address(d)) == 99 && uni.requested(address(b)) == 101);
        require(d.allowance(address(executor), address(pancake)) == 0);
        clean();
    }

    function testTransferTaxOnPullReverts() public {
        CallbackToken token = new CallbackToken();
        token.mint(address(this), 101);
        token.approve(address(executor), 101);
        token.tax(address(this));
        vm.expectRevert(Executor.BalanceMismatch.selector);
        executor.execute(address(token), address(c), 101, 0, 1000, split(false));
        require(token.balanceOf(address(this)) == 101 && token.allowance(address(this), address(executor)) == 101);
    }

    function testTransferTaxOnPayoutRevertsBothRoutes() public {
        CallbackToken token = new CallbackToken();
        token.mint(address(uni), 1000);
        token.mint(address(pancake), 1000);
        token.tax(address(executor));
        Executor.Allocation[] memory r = split(false);
        r[0].hops[0].tokenOut = address(token);
        r[1].hops[0].tokenOut = address(token);
        vm.expectRevert(Executor.BalanceMismatch.selector);
        executor.execute(address(a), address(token), 101, 0, 1000, r);
        require(uni.spent(address(a)) == 0 && pancake.spent(address(a)) == 0);
        require(token.balanceOf(address(this)) == 0 && a.balanceOf(address(this)) == 1e30);
    }

    function testTokenReentrancyOnPullAndPayoutRejected() public {
        CallbackToken input = new CallbackToken();
        CallbackToken output = new CallbackToken();
        input.mint(address(this), 101);
        input.approve(address(executor), 101);
        output.mint(address(uni), 1000);
        output.mint(address(pancake), 1000);
        uni.configure(address(input), 101);
        pancake.configure(address(input), 99);
        Executor.Allocation[] memory r = split(false);
        r[0].hops[0].tokenOut = address(output);
        r[1].hops[0].tokenOut = address(output);
        bytes memory data = abi.encodeCall(executor.execute, (address(input), address(output), 101, 200, 1000, r));
        input.callback(address(this), address(executor), data);
        output.callback(address(executor), address(executor), data);
        require(executor.execute(address(input), address(output), 101, 200, 1000, r) == 200);
        require(input.rejected() && output.rejected(), "callbacks not exercised");
        require(input.balanceOf(address(this)) == 0 && output.balanceOf(address(this)) == 200);
    }

    function testFuzzValidTwoHopSplitPreservesBalances(uint96 x, uint96 y, uint64 dust) public {
        uint256 first = uint256(x) % 1e20 + 1;
        uint256 second = uint256(y) % 1e20 + 1;
        Executor.Allocation[] memory r = split(true);
        r[0].amountIn = first;
        r[1].amountIn = second;
        uni.configure(address(a), first * 3 + 7);
        pancake.configure(address(a), second * 2 + 11);
        uni.configure(address(b), first * 5 + 13);
        pancake.configure(address(b), second * 7 + 17);
        a.mint(address(executor), dust);
        b.mint(address(executor), uint256(dust) + 1);
        c.mint(address(executor), uint256(dust) + 2);
        uint256 expected = first * 5 + second * 7 + 30;
        require(run(r, first + second, expected) == expected);
        require(a.balanceOf(address(this)) == 1e30 - first - second);
        require(c.balanceOf(address(this)) == expected);
        require(uni.requested(address(b)) == first * 3 + 7 && pancake.requested(address(b)) == second * 2 + 11);
        require(
            a.balanceOf(address(executor)) == dust && b.balanceOf(address(executor)) == uint256(dust) + 1
                && c.balanceOf(address(executor)) == uint256(dust) + 2
        );
        clean();
    }
}
