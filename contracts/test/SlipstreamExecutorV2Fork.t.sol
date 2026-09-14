// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ExecutorV2} from "../src/ExecutorV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface VmSlipstreamExecutorV2Fork {
    function deal(address account, uint256 newBalance) external;
}

interface IWethSlipstreamExecutorV2Fork {
    function deposit() external payable;
}

contract ForceNative {
    constructor() payable {}

    function send(address payable recipient) external {
        selfdestruct(recipient);
    }
}

contract SlipstreamExecutorV2ForkTest {
    VmSlipstreamExecutorV2Fork private constant vm =
        VmSlipstreamExecutorV2Fork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    address private constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 private constant INPUT = 10_000_000_000_000;

    ExecutorV2 private executor;
    bool private forkActive;

    function setUp() public {
        if (block.chainid != 8453) return;
        forkActive = true;
        require(ROUTER.balance == 0, "router starts with native balance");
        executor = new ExecutorV2(
            address(0), address(0), ROUTER, address(0), address(0), address(0), address(0), new bytes32[](0)
        );
        vm.deal(address(this), 1 ether);
        IWethSlipstreamExecutorV2Fork(WETH).deposit{value: INPUT}();
        IERC20(WETH).approve(address(executor), INPUT);
    }

    receive() external payable {}

    function testFinalExecutorUsesMeasuredOutputAndRefundsOneWei() public {
        if (!forkActive) return;
        new ForceNative{value: 1}().send(payable(ROUTER));
        uint256 inputBefore = IERC20(WETH).balanceOf(address(this));
        uint256 outputBefore = IERC20(USDC).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        uint256 amountOut = executor.execute(plan());

        require(inputBefore - IERC20(WETH).balanceOf(address(this)) == INPUT, "input debit mismatch");
        require(amountOut == IERC20(USDC).balanceOf(address(this)) - outputBefore, "output mismatch");
        require(amountOut > 0, "no measured output");
        require(address(this).balance == nativeBefore + 1, "native refund mismatch");
        require(IERC20(WETH).balanceOf(address(executor)) == 0, "executor input residue");
        require(IERC20(USDC).balanceOf(address(executor)) == 0, "executor output residue");
        require(IERC20(WETH).allowance(address(executor), ROUTER) == 0, "allowance residue");
        require(address(executor).balance == 0, "executor native residue");
    }

    function testFinalExecutorRejectsRouterNativeFundingAndRollsBack() public {
        if (!forkActive) return;
        new ForceNative{value: INPUT}().send(payable(ROUTER));
        uint256 inputBefore = IERC20(WETH).balanceOf(address(this));
        uint256 outputBefore = IERC20(USDC).balanceOf(address(this));

        (bool ok,) = address(executor).call(abi.encodeCall(ExecutorV2.execute, (plan())));

        require(!ok, "native-funded execution succeeded");
        require(IERC20(WETH).balanceOf(address(this)) == inputBefore, "input did not roll back");
        require(IERC20(USDC).balanceOf(address(this)) == outputBefore, "output did not roll back");
        require(IERC20(WETH).allowance(address(executor), ROUTER) == 0, "allowance did not roll back");
        require(IERC20(WETH).balanceOf(address(executor)) == 0, "executor input changed");
        require(IERC20(USDC).balanceOf(address(executor)) == 0, "executor output changed");
        require(ROUTER.balance == INPUT, "router native did not roll back");
    }

    function plan() private view returns (ExecutorV2.Plan memory value) {
        ExecutorV2.Operation[] memory operations = new ExecutorV2.Operation[](1);
        operations[0] = ExecutorV2.Operation({kind: 3, tokenOut: USDC, fee: 0, tickSpacing: 100, poolId: bytes32(0)});
        ExecutorV2.Branch[] memory branches = new ExecutorV2.Branch[](1);
        branches[0] = ExecutorV2.Branch({amountIn: INPUT, minAmountOut: 1, operations: operations});
        value = ExecutorV2.Plan({
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: INPUT,
            minAmountOut: 1,
            deadline: block.timestamp,
            branches: branches
        });
    }
}
