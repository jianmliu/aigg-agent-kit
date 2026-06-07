// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KvWorld} from "../src/KvWorld.sol";

contract KvWorldTest is Test {
    KvWorld world;
    address owner = address(this);
    address writer = makeAddr("writer");
    address attacker = makeAddr("attacker");

    bytes32 constant ZERO = bytes32(0);
    bytes32 constant K = keccak256("npc:jiu-jianxian");

    function setUp() public {
        world = new KvWorld(); // deployer (this) = owner + first writer
    }

    function _set(bytes32 key, bytes memory val) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("kvSet(bytes32,bytes)", key, val);
    }

    function test_OwnerIsDeployerAndWriter() public view {
        assertEq(world.owner(), owner);
        assertTrue(world.isWriter(owner));
    }

    function test_WriterCanWrite_ReadPublic() public {
        world.call(ZERO, _set(K, bytes("cid:abc")));
        (, , bytes memory dyn) = world.getRecord(ZERO, _arr(K));
        assertEq(string(dyn), "cid:abc");
        assertEq(string(world.get(K)), "cid:abc");
    }

    function test_NonWriter_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert(KvWorld.NotWriter.selector);
        world.call(ZERO, _set(K, bytes("evil")));
    }

    function test_OwnerCanGrantWriter() public {
        world.setWriter(writer, true);
        assertTrue(world.isWriter(writer));
        vm.prank(writer);
        world.call(ZERO, _set(K, bytes("ok")));
        assertEq(string(world.get(K)), "ok");
    }

    function test_NonOwnerCannotGrantWriter() public {
        vm.prank(attacker);
        vm.expectRevert(KvWorld.NotOwner.selector);
        world.setWriter(attacker, true);
    }

    function test_RevokedWriter_Reverts() public {
        world.setWriter(writer, true);
        world.setWriter(writer, false);
        vm.prank(writer);
        vm.expectRevert(KvWorld.NotWriter.selector);
        world.call(ZERO, _set(K, bytes("x")));
    }

    function test_ReadsArePublic_evenForAttacker() public {
        world.call(ZERO, _set(K, bytes("v")));   // owner writes
        vm.prank(attacker);                        // attacker reads — allowed
        assertEq(string(world.get(K)), "v");
    }

    function _arr(bytes32 k) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1); a[0] = k;
    }
}
