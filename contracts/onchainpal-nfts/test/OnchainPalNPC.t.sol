// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OnchainPalNPC} from "../src/OnchainPalNPC.sol";

contract OnchainPalNPCTest is Test {
    OnchainPalNPC nft;
    address owner = address(0xA11CE);
    address player = address(0xB0B);

    function setUp() public {
        nft = new OnchainPalNPC(owner);
    }

    function test_mintAssignsNpcIdAndUri() public {
        vm.prank(owner);
        uint256 id = nft.mint(player, "npc:jiu-jianxian", "ipfs://bafy123/jiu-jianxian.json");
        assertEq(id, 1);
        assertEq(nft.nextTokenId(), 2);
        assertEq(nft.ownerOf(id), player);
        assertEq(nft.npcIdOf(id), "npc:jiu-jianxian");
        assertEq(nft.tokenURI(id), "ipfs://bafy123/jiu-jianxian.json");
    }

    function test_mintOnlyOwner() public {
        vm.expectRevert();
        vm.prank(player);
        nft.mint(player, "npc:azhu", "ipfs://x");
    }

    function test_mintRejectsEmptyNpcId() public {
        vm.prank(owner);
        vm.expectRevert(OnchainPalNPC.EmptyNpcId.selector);
        nft.mint(player, "", "ipfs://x");
    }

    function test_setTokenURIOnlyOwner() public {
        vm.prank(owner);
        uint256 id = nft.mint(player, "npc:azhu", "ipfs://old");
        vm.expectRevert();
        vm.prank(player);
        nft.setTokenURI(id, "ipfs://new");
        vm.prank(owner);
        nft.setTokenURI(id, "ipfs://new");
        assertEq(nft.tokenURI(id), "ipfs://new");
    }

    function test_tokenURIRevertsForUnknown() public {
        vm.expectRevert(OnchainPalNPC.TokenDoesNotExist.selector);
        nft.tokenURI(999);
    }

    function test_threeHeroNPCsMintCleanly() public {
        vm.startPrank(owner);
        uint256 a = nft.mint(player, "npc:azhu", "ipfs://a");
        uint256 b = nft.mint(player, "npc:li-daniang", "ipfs://b");
        uint256 c = nft.mint(player, "npc:jiu-jianxian", "ipfs://c");
        vm.stopPrank();
        assertEq(a, 1); assertEq(b, 2); assertEq(c, 3);
        assertEq(nft.npcIdOf(a), "npc:azhu");
        assertEq(nft.npcIdOf(c), "npc:jiu-jianxian");
    }
}
