// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestToken} from "../src/TestToken.sol";
import {LiquiditySeeder} from "../src/LiquiditySeeder.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function getCode(string calldata) external returns (bytes memory);
}

interface Bootstrap {
    function deployer() external view returns (address);
    function factory() external view returns (address);
}

interface Factory {
    function createPool(address, address, uint24) external returns (address);
    function owner() external view returns (address);
}

interface Pool {
    function initialize(uint160) external;
    function liquidity() external view returns (uint128);
}

interface Router {
    struct Params {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(Params calldata) external payable returns (uint256);

    struct PathParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(PathParams calldata) external payable returns (uint256);
}

contract HarnessTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testAsymmetricTokenAmountsAndAllowance() public {
        TestToken a = new TestToken("A", 18);
        TestToken b = new TestToken("B", 6);
        TestToken c = new TestToken("C", 8);
        a.mint(address(this), 123e18);
        b.mint(address(this), 456e6);
        c.mint(address(this), 789e8);
        require(a.decimals() == 18 && b.decimals() == 6 && c.decimals() == 8);
        b.approve(address(7), 17e6);
        vm.prank(address(7));
        b.transferFrom(address(this), address(8), 13e6);
        require(b.balanceOf(address(this)) == 443e6);
        require(b.balanceOf(address(8)) == 13e6 && b.allowance(address(this), address(7)) == 4e6);
        require(a.totalSupply() == 123e18 && c.totalSupply() == 789e8);
        vm.expectRevert(bytes("owner only"));
        vm.prank(address(7));
        a.mint(address(7), 1);
    }

    function testUnauthorizedSeedingAndCallbacks() public {
        LiquiditySeeder seeder = new LiquiditySeeder();
        vm.expectRevert(bytes("owner only"));
        vm.prank(address(7));
        seeder.seed(address(0), address(0), -10, 10, 1);
        vm.expectRevert(bytes("unexpected callback"));
        seeder.uniswapV3MintCallback(1, 2, "");
        vm.expectRevert(bytes("unexpected callback"));
        seeder.pancakeV3MintCallback(3, 4, "");
    }

    function deployArtifact(string memory path, bytes memory args) private returns (address deployed) {
        bytes memory init = abi.encodePacked(vm.getCode(path), args);
        assembly { deployed := create(0, add(init, 32), mload(init)) }
        require(deployed != address(0), "artifact deployment failed");
    }

    function testRealPancakeMintAndPartialInputConsumption() public {
        Bootstrap bootstrap = Bootstrap(deployArtifact("../.testnet/PancakeBootstrap.json", ""));
        require(Factory(bootstrap.factory()).owner() == address(this), "factory ownership");
        TestToken a = new TestToken("A", 18);
        TestToken b = new TestToken("B", 6);
        address pool = Factory(bootstrap.factory()).createPool(address(a), address(b), 2500);
        bool aFirst = address(a) < address(b);
        Pool(pool).initialize(aFirst ? uint160((uint256(1) << 96) / 1e6) : uint160((uint256(1) << 96) * 1e6));
        LiquiditySeeder seeder = new LiquiditySeeder();
        a.mint(address(this), 1_000_000e18);
        b.mint(address(this), 1_000_000e6);
        a.approve(address(seeder), type(uint256).max);
        b.approve(address(seeder), type(uint256).max);
        seeder.seed(
            bootstrap.factory(),
            pool,
            aFirst ? int24(-276450) : int24(276200),
            aFirst ? int24(-276200) : int24(276450),
            1e16
        );
        require(Pool(pool).liquidity() == 1e16, "liquidity not minted");
        require(a.balanceOf(pool) > 0 && b.balanceOf(pool) > 0, "callback did not fund both tokens");
        Router router = Router(
            deployArtifact(
                "../scripts/testnet/node_modules/@pancakeswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
                abi.encode(bootstrap.deployer(), bootstrap.factory(), address(1))
            )
        );
        a.approve(address(router), type(uint256).max);
        uint256 beforeA = a.balanceOf(address(this));
        uint256 beforeB = b.balanceOf(address(this));
        uint256 requested = 100_000e18;
        uint256 output = router.exactInputSingle(
            Router.Params(address(a), address(b), 2500, address(this), block.timestamp, requested, 1, 0)
        );
        uint256 consumed = beforeA - a.balanceOf(address(this));
        require(consumed > 0 && consumed < requested / 100, "expected partial consumption");
        require(output > 0 && b.balanceOf(address(this)) - beforeB == output, "actual output mismatch");
        require(Pool(pool).liquidity() == 0, "range not exhausted");
    }

    function testRealPancakeTwoHopLeavesIntermediateResidue() public {
        Bootstrap bootstrap = Bootstrap(deployArtifact("../.testnet/PancakeBootstrap.json", ""));
        TestToken a = new TestToken("A", 18);
        TestToken b = new TestToken("B", 6);
        TestToken c = new TestToken("C", 8);
        LiquiditySeeder seeder = new LiquiditySeeder();
        a.mint(address(this), 1_000_000e18);
        b.mint(address(this), 1_000_000e6);
        c.mint(address(this), 1_000_000e8);
        a.approve(address(seeder), type(uint256).max);
        b.approve(address(seeder), type(uint256).max);
        c.approve(address(seeder), type(uint256).max);
        {
            address ab = Factory(bootstrap.factory()).createPool(address(a), address(b), 500);
            bool aFirst = address(a) < address(b);
            Pool(ab).initialize(aFirst ? uint160((uint256(1) << 96) / 1e6) : uint160((uint256(1) << 96) * 1e6));
            int24 center = aFirst ? int24(-276330) : int24(276320);
            seeder.seed(bootstrap.factory(), ab, center - 12000, center + 12000, 1e16);
            address bc = Factory(bootstrap.factory()).createPool(address(b), address(c), 2500);
            bool bFirst = address(b) < address(c);
            Pool(bc).initialize(bFirst ? uint160((uint256(1) << 96) * 10) : uint160((uint256(1) << 96) / 10));
            center = bFirst ? int24(46050) : int24(-46100);
            seeder.seed(bootstrap.factory(), bc, center - 100, center + 100, 1e11);
        }
        Router router = Router(
            deployArtifact(
                "../scripts/testnet/node_modules/@pancakeswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
                abi.encode(bootstrap.deployer(), bootstrap.factory(), address(1))
            )
        );
        a.approve(address(router), type(uint256).max);
        uint256 beforeA = a.balanceOf(address(this));
        uint256 beforeC = c.balanceOf(address(this));
        uint256 beforeRouterB = b.balanceOf(address(router));
        uint256 output = router.exactInput(
            Router.PathParams(
                abi.encodePacked(address(a), uint24(500), address(b), uint24(2500), address(c)),
                address(this),
                block.timestamp,
                1000e18,
                1
            )
        );
        require(beforeA - a.balanceOf(address(this)) == 1000e18, "first input not fully consumed");
        require(output > 0 && c.balanceOf(address(this)) - beforeC == output, "successful final output required");
        require(b.balanceOf(address(router)) > beforeRouterB + 100e6, "expected intermediate residue");
    }
}
