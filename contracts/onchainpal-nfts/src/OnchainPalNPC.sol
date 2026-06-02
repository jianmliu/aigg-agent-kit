// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title OnchainPalNPC
/// @notice Each AI NPC is an ERC-721 token. ERC-6551 pairs every token with its
///         own Token Bound Account (TBA), which can HOLD GCC and receive
///         donations — the on-chain identity + economic agent for that NPC.
/// @dev Mint is owner-only (game backend). `tokenURI(tokenId)` resolves to the
///      persona/画像 metadata (typically an Auto Drive CID, e.g. ipfs://<cid>).
///      `npcIdOf(tokenId)` returns the canonical npcId (e.g. "npc:jiu-jianxian")
///      so off-chain the engine-neutral NPC runtime can index by it.
contract OnchainPalNPC is ERC721, Ownable {
    using Strings for uint256;

    /// @notice canonical npcId string (e.g. "npc:jiu-jianxian") for each token.
    mapping(uint256 => string) public npcIdOf;
    /// @notice per-token metadata URI (Auto Drive CID URL or ipfs://...).
    mapping(uint256 => string) private _tokenURIs;
    /// @notice next token id to mint; starts at 1.
    uint256 public nextTokenId = 1;

    event NPCMinted(uint256 indexed tokenId, address indexed to, string npcId, string uri);
    event TokenURIUpdated(uint256 indexed tokenId, string uri);

    error TokenDoesNotExist();
    error EmptyNpcId();

    constructor(address initialOwner) ERC721("Onchain PAL NPC", "PALNPC") Ownable(initialOwner) {}

    /// @notice Mint a new NPC NFT. Game backend only.
    /// @param to Recipient (game treasury for hero NPCs; or a player wallet for
    ///           "patron-owned" NPCs in I+B3 phase).
    /// @param npcId Canonical npcId string (must be non-empty).
    /// @param uri Metadata URI — pointer to the picked persona/画像; typically
    ///            `ipfs://<auto-drive-cid>` or `https://...`.
    function mint(address to, string calldata npcId, string calldata uri) external onlyOwner returns (uint256 tokenId) {
        if (bytes(npcId).length == 0) revert EmptyNpcId();
        tokenId = nextTokenId++;
        npcIdOf[tokenId] = npcId;
        _tokenURIs[tokenId] = uri;
        _safeMint(to, tokenId);
        emit NPCMinted(tokenId, to, npcId, uri);
    }

    /// @notice Update a token's metadata URI (e.g. after re-generating the card).
    function setTokenURI(uint256 tokenId, string calldata uri) external onlyOwner {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        _tokenURIs[tokenId] = uri;
        emit TokenURIUpdated(tokenId, uri);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        return _tokenURIs[tokenId];
    }
}
