// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Executor, IUniswapRouter02, IPancakeRouter} from "../src/Executor.sol";
import {LiquiditySeeder} from "../src/LiquiditySeeder.sol";
import {TestToken} from "../src/TestToken.sol";

interface RealVm {
    function getCode(string calldata) external returns (bytes memory);
    function expectRevert(bytes4) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface RealBootstrap {
    function deployer() external view returns (address);
    function factory() external view returns (address);
}

interface RealFactory {
    function createPool(address, address, uint24) external returns (address);
    function enableFeeAmount(uint24, int24) external;
}

interface RealPool {
    function initialize(uint160) external;
    function liquidity() external view returns (uint128);
    function feeGrowthGlobal0X128() external view returns (uint256);
    function feeGrowthGlobal1X128() external view returns (uint256);
}

contract ExecutorRoutersTest {
    RealVm constant vm = RealVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestToken a;
    TestToken b;
    TestToken c;
    Executor executor;
    LiquiditySeeder seeder;
    address uni;
    address pancake;
    address uniFactory;
    address pancakeFactory;

    function deploy(string memory path, bytes memory args) private returns (address deployed) {
        bytes memory init = abi.encodePacked(vm.getCode(path), args);
        assembly { deployed := create(0, add(init, 32), mload(init)) }
        require(deployed != address(0), "artifact deployment");
    }

    function setUp() public {
        uniFactory = deploy(
            "../scripts/testnet/node_modules/@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
            ""
        );
        uni = deploy(
            "../scripts/testnet/node_modules/@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json",
            abi.encode(address(0), uniFactory, address(0), address(1))
        );
        RealBootstrap bootstrap = RealBootstrap(deploy("../.testnet/PancakeBootstrap.json", ""));
        pancakeFactory = bootstrap.factory();
        pancake = deploy(
            "../scripts/testnet/node_modules/@pancakeswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
            abi.encode(bootstrap.deployer(), pancakeFactory, address(1))
        );
        executor = new Executor(uni, pancake);
        seeder = new LiquiditySeeder();
        a = new TestToken("A", 18);
        b = new TestToken("B", 18);
        c = new TestToken("C", 18);
        fund(a);
        fund(b);
        fund(c);
    }

    function fund(TestToken token) private {
        token.mint(address(this), 1e30);
        token.approve(address(seeder), type(uint256).max);
        token.approve(address(executor), type(uint256).max);
        token.approve(uni, type(uint256).max);
        token.approve(pancake, type(uint256).max);
    }

    function pool(address factory, TestToken input, TestToken output, uint24 fee, bool narrow)
        private
        returns (address p)
    {
        p = RealFactory(factory).createPool(address(input), address(output), fee);
        RealPool(p).initialize(uint160(1 << 96));
        seeder.seed(
            factory,
            p,
            narrow ? int24(-10) : int24(-600000),
            narrow ? int24(10) : int24(600000),
            narrow ? uint128(1e12) : uint128(1e24)
        );
    }

    function route(uint8 venue, uint256 amount, bool twoHop) private view returns (Executor.Allocation memory r) {
        r.venue = venue;
        r.amountIn = amount;
        r.hops = new Executor.Hop[](twoHop ? 2 : 1);
        r.hops[0] = Executor.Hop(twoHop ? address(b) : address(c), 500);
        if (twoHop) r.hops[1] = Executor.Hop(address(c), 500);
    }

    function direct(uint8 venue, TestToken input, TestToken output, uint256 amount, uint24 fee)
        private
        returns (uint256)
    {
        if (venue == 0) {
            return IUniswapRouter02(uni)
                .exactInputSingle(
                    IUniswapRouter02.ExactInputSingleParams(
                        address(input), address(output), fee, address(this), amount, 0, 0
                    )
                );
        }
        return IPancakeRouter(pancake)
            .exactInputSingle(
                IPancakeRouter.ExactInputSingleParams(
                    address(input), address(output), fee, address(this), block.timestamp, amount, 0, 0
                )
            );
    }

    function state(address p, TestToken input, TestToken output) private view returns (bytes32) {
        (bool ok, bytes memory slot0) = p.staticcall(abi.encodeWithSignature("slot0()"));
        require(ok);
        return keccak256(
            abi.encode(
                slot0,
                RealPool(p).liquidity(),
                RealPool(p).feeGrowthGlobal0X128(),
                RealPool(p).feeGrowthGlobal1X128(),
                input.balanceOf(p),
                output.balanceOf(p)
            )
        );
    }

    function dust() private {
        a.mint(address(executor), 7);
        b.mint(address(executor), 11);
        c.mint(address(executor), 13);
        a.mint(uni, 17);
        b.mint(uni, 19);
        c.mint(uni, 23);
        a.mint(pancake, 29);
        b.mint(pancake, 31);
        c.mint(pancake, 37);
    }

    function clean() private view {
        require(
            a.balanceOf(address(executor)) == 7 && b.balanceOf(address(executor)) == 11
                && c.balanceOf(address(executor)) == 13,
            "executor dust"
        );
        require(a.balanceOf(uni) == 17 && b.balanceOf(uni) == 19 && c.balanceOf(uni) == 23, "uni dust");
        require(a.balanceOf(pancake) == 29 && b.balanceOf(pancake) == 31 && c.balanceOf(pancake) == 37, "pancake dust");
        require(a.allowance(address(executor), uni) == 0 && b.allowance(address(executor), uni) == 0, "uni approval");
        require(
            a.allowance(address(executor), pancake) == 0 && b.allowance(address(executor), pancake) == 0,
            "pancake approval"
        );
    }

    function testAuthenticUniswapSingleAndPancakeTwoHopSplit() public {
        pool(uniFactory, a, c, 500, false);
        pool(pancakeFactory, a, b, 500, false);
        pool(pancakeFactory, b, c, 500, false);
        uint256 snapshot = vm.snapshotState();
        uint256 expected = direct(0, a, c, 37e18, 500) + direct(1, b, c, direct(1, a, b, 64e18, 500), 500);
        require(vm.revertToState(snapshot));
        Executor.Allocation[] memory r = new Executor.Allocation[](2);
        r[0] = route(0, 37e18, false);
        r[1] = route(1, 64e18, true);
        dust();
        uint256 beforeA = a.balanceOf(address(this));
        uint256 beforeC = c.balanceOf(address(this));
        require(executor.execute(address(a), address(c), 101e18, expected, block.timestamp, r) == expected);
        require(a.balanceOf(address(this)) == beforeA - 101e18 && c.balanceOf(address(this)) == beforeC + expected);
        clean();
    }

    function testAuthenticTwoHopBothVenuesSharedIntermediate() public {
        pool(uniFactory, a, b, 500, false);
        pool(uniFactory, b, c, 500, false);
        pool(pancakeFactory, a, b, 500, false);
        pool(pancakeFactory, b, c, 500, false);
        uint256 snapshot = vm.snapshotState();
        uint256 expected =
            direct(0, b, c, direct(0, a, b, 37e18, 500), 500) + direct(1, b, c, direct(1, a, b, 64e18, 500), 500);
        require(vm.revertToState(snapshot));
        Executor.Allocation[] memory r = new Executor.Allocation[](2);
        r[0] = route(0, 37e18, true);
        r[1] = route(1, 64e18, true);
        dust();
        require(executor.execute(address(a), address(c), 101e18, expected, block.timestamp, r) == expected);
        clean();
    }

    function testAuthenticFeeZeroBothVenues() public {
        RealFactory(uniFactory).enableFeeAmount(0, 10);
        RealFactory(pancakeFactory).enableFeeAmount(0, 10);
        pool(uniFactory, a, c, 0, false);
        pool(pancakeFactory, a, c, 0, false);
        Executor.Allocation[] memory r = new Executor.Allocation[](2);
        r[0] = route(0, 37e18, false);
        r[1] = route(1, 64e18, false);
        r[0].hops[0].fee = 0;
        r[1].hops[0].fee = 0;
        dust();
        require(executor.execute(address(a), address(c), 101e18, 100e18, block.timestamp, r) > 100e18);
        clean();
    }

    function testAuthenticPartialFirstHopBothVenuesRevert() public {
        address up = pool(uniFactory, a, c, 500, true);
        address pp = pool(pancakeFactory, a, c, 500, true);
        dust();
        for (uint8 venue; venue < 2; ++venue) {
            address p = venue == 0 ? up : pp;
            bytes32 beforePool = state(p, a, c);
            uint256 snapshot = vm.snapshotState();
            uint256 beforeA = a.balanceOf(address(this));
            require(direct(venue, a, c, 101e18, 500) > 0, "partial output must pass min1");
            require(beforeA - a.balanceOf(address(this)) < 101e18, "not partial");
            require(vm.revertToState(snapshot));
            Executor.Allocation[] memory r = new Executor.Allocation[](1);
            r[0] = route(venue, 101e18, false);
            vm.expectRevert(Executor.IncompleteSpend.selector);
            executor.execute(address(a), address(c), 101e18, 1, block.timestamp, r);
            require(state(p, a, c) == beforePool, "pool rollback");
            require(a.balanceOf(address(this)) == beforeA, "caller rollback");
            clean();
        }
    }

    function testAuthenticPartialSecondHopBothVenuesRevert() public {
        address ua = pool(uniFactory, a, b, 500, false);
        address ub = pool(uniFactory, b, c, 500, true);
        address pa = pool(pancakeFactory, a, b, 500, false);
        address pb = pool(pancakeFactory, b, c, 500, true);
        dust();
        for (uint8 venue; venue < 2; ++venue) {
            address first = venue == 0 ? ua : pa;
            address second = venue == 0 ? ub : pb;
            bytes32 firstState = state(first, a, b);
            bytes32 secondState = state(second, b, c);
            uint256 snapshot = vm.snapshotState();
            uint256 intermediate = direct(venue, a, b, 101e18, 500);
            uint256 beforeB = b.balanceOf(address(this));
            require(direct(venue, b, c, intermediate, 500) > 0, "partial output must pass min1");
            require(beforeB - b.balanceOf(address(this)) < intermediate, "not partial hop2");
            require(vm.revertToState(snapshot));
            Executor.Allocation[] memory r = new Executor.Allocation[](1);
            r[0] = route(venue, 101e18, true);
            vm.expectRevert(Executor.IncompleteSpend.selector);
            executor.execute(address(a), address(c), 101e18, 1, block.timestamp, r);
            require(state(first, a, b) == firstState && state(second, b, c) == secondState, "both pools rollback");
            clean();
        }
    }

    function testAuthenticSecondVenuePartialRollsBackFirstPool() public {
        address up = pool(uniFactory, a, c, 500, false);
        address pp = pool(pancakeFactory, a, c, 500, true);
        bytes32 beforeUni = state(up, a, c);
        bytes32 beforePancake = state(pp, a, c);
        uint256 snapshot = vm.snapshotState();
        require(direct(0, a, c, 37e18, 500) > 36e18);
        require(state(up, a, c) != beforeUni, "first pool must actually change");
        require(vm.revertToState(snapshot));
        Executor.Allocation[] memory r = new Executor.Allocation[](2);
        r[0] = route(0, 37e18, false);
        r[1] = route(1, 64e18, false);
        dust();
        uint256 caller = a.balanceOf(address(this));
        vm.expectRevert(Executor.IncompleteSpend.selector);
        executor.execute(address(a), address(c), 101e18, 1, block.timestamp, r);
        require(state(up, a, c) == beforeUni && state(pp, a, c) == beforePancake, "cross-venue pool rollback");
        require(a.balanceOf(address(this)) == caller, "caller rollback");
        clean();
    }
}
