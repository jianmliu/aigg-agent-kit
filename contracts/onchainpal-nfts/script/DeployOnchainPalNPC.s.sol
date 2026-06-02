// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OnchainPalNPC} from "../src/OnchainPalNPC.sol";

/// @notice Deploy OnchainPalNPC and (optionally) mint the 3 hero NPCs in one tx
///         batch. ETH gas is paid by msg.sender; keep the owner key off-laptop
///         (pass via --private-key with `cast wallet decrypt` / hw / -- env, never
///         hard-coded).
///
/// Env:
///   NPC_OWNER        — initial owner (game treasury / AIGG deployer).
///                       Defaults to the deployer address (broadcast key).
///   AZHU_URI         — ipfs://… (optional, will skip if empty)
///   LI_DANIANG_URI   — ipfs://… (optional)
///   JIU_JIANXIAN_URI — ipfs://…  (optional)
///   MINT_TO          — recipient for the 3 mints (default = NPC_OWNER)
///
/// Run (Sepolia, dry-run):
///   forge script script/DeployOnchainPalNPC.s.sol \
///     --rpc-url https://sepolia.base.org --sender 0xYOUR
/// Real:
///   forge script script/DeployOnchainPalNPC.s.sol \
///     --rpc-url https://sepolia.base.org --broadcast --private-key $KEY
contract DeployOnchainPalNPC is Script {
    function run() external returns (OnchainPalNPC nft) {
        address owner = vm.envOr("NPC_OWNER", msg.sender);
        address mintTo = vm.envOr("MINT_TO", owner);

        string memory azhu = vm.envOr("AZHU_URI", string(""));
        string memory liDa = vm.envOr("LI_DANIANG_URI", string(""));
        string memory jjx  = vm.envOr("JIU_JIANXIAN_URI", string(""));

        vm.startBroadcast();
        nft = new OnchainPalNPC(owner);
        console2.log("OnchainPalNPC deployed at:", address(nft));
        console2.log("initial owner            :", owner);

        if (msg.sender == owner) {
            if (bytes(azhu).length > 0) {
                uint256 id = nft.mint(mintTo, "npc:azhu", azhu);
                console2.log("minted #", id, "npc:azhu");
            }
            if (bytes(liDa).length > 0) {
                uint256 id = nft.mint(mintTo, "npc:li-daniang", liDa);
                console2.log("minted #", id, "npc:li-daniang");
            }
            if (bytes(jjx).length > 0) {
                uint256 id = nft.mint(mintTo, "npc:jiu-jianxian", jjx);
                console2.log("minted #", id, "npc:jiu-jianxian");
            }
        } else {
            console2.log("(deployer != owner; skipping initial mints - owner can mint later)");
        }
        vm.stopBroadcast();
    }
}
