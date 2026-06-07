// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

/**
 * KvWorld — the global, mutable, permissionless head-CID index for the
 * cross-server NPC world (PR-B, trustless path).
 *
 * Why this contract exists
 * ------------------------
 * Cross-server federation needs ONE shared, mutable pointer store: the "current
 * head CID" for each (scope,key). Content-addressed blobs (NPC identity/memory)
 * live in the global DSN — reachable by CID from any server — but DSN is
 * immutable, so it cannot hold the *moving* head pointer. That pointer must live
 * somewhere globally readable AND writable. On-chain is the only trustless
 * option: any server reading the same World sees the same heads.
 *
 * Why a minimal KV instead of a full latticexyz MUD World
 * --------------------------------------------------------
 * The kit's `MudWorldKvClient` only needs four operations, and it passes the
 * MUD-derived tableId/systemId as opaque routing args:
 *   - write:  World.call(systemId, abi(kvSet|kvDel, ...))   (any account)
 *   - read:   World.getRecord(tableId, [key]) -> (_, _, dynamicData)
 * A full ECS World (namespaces, tables, indexer) adds large surface area we do
 * not need for a head pointer. This contract implements exactly that ABI as a
 * permissionless KV: minimal, auditable, swap-in. If ECS tooling is later
 * wanted, deploy a real latticexyz World — the client is unchanged.
 *
 * Tiering invariant (enforced by the store layer, not here): only the STABLE,
 * cross-server subset — NPC identity/registry + their DSN head CIDs — is written
 * to this contract. HOT per-visitor state (relationships, GCC balance) stays in
 * each server's local warm tier and is snapshotted to the shared tier only at
 * milestones, so routine conversation never costs a transaction.
 *
 * Write authorization (C1): kvSet/kvDel are gated to an owner-managed writer
 * allowlist (the ai.gg world-writer EOA(s), e.g. held in wallet-svc) — this
 * removes the "anyone can overwrite any NPC's head / the registry" corruption
 * vector. READS stay public (any server syncs the world freely). This is the
 * ai.gg-operated trust model for the current stage; truly permissionless
 * federation (per-key owner signatures) is a later, harder design. Cross-server
 * trust comes from content-addressing (a head CID names an immutable blob) plus
 * application-level ownership inside the stored value, not from write gating.
 */
contract KvWorld {
    // selector routing for World.call(systemId, callData)
    bytes4 private constant KV_SET = bytes4(keccak256("kvSet(bytes32,bytes)"));
    bytes4 private constant KV_DEL = bytes4(keccak256("kvDel(bytes32)"));

    mapping(bytes32 => bytes) private _value;

    /// @notice contract owner — manages the writer allowlist.
    address public owner;
    /// @notice authorized writers — only these may kvSet/kvDel (reads stay public).
    mapping(address => bool) public isWriter;

    event KvSet(bytes32 indexed key, bytes value);
    event KvDel(bytes32 indexed key);
    event WriterSet(address indexed writer, bool allowed);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotWriter();

    /// deployer is the owner and the first authorized writer.
    constructor() {
        owner = msg.sender;
        isWriter[msg.sender] = true;
        emit WriterSet(msg.sender, true);
    }

    /// @notice add/remove an authorized writer (the ai.gg world-writer EOA(s),
    /// e.g. held in wallet-svc). Owner-only.
    function setWriter(address writer, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        isWriter[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    /// @notice transfer ownership (e.g. to a multisig). Owner-only.
    function transferOwnership(address to) external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    /**
     * MUD-World-compatible entry point. `MudWorldKvClient` routes writes here as
     * World.call(systemId, callData). systemId is opaque routing and ignored —
     * this World hosts exactly one (KvSystem) surface. Gated: only authorized
     * writers may mutate (C1 — prevents arbitrary overwrite of the shared world).
     */
    function call(bytes32, bytes calldata callData) external payable returns (bytes memory) {
        if (!isWriter[msg.sender]) revert NotWriter();
        bytes4 sel = bytes4(callData[0:4]);
        if (sel == KV_SET) {
            (bytes32 key, bytes memory value) = abi.decode(callData[4:], (bytes32, bytes));
            _value[key] = value;
            emit KvSet(key, value);
        } else if (sel == KV_DEL) {
            bytes32 key = abi.decode(callData[4:], (bytes32));
            delete _value[key];
            emit KvDel(key);
        } else {
            revert("KvWorld: unknown system call");
        }
        return "";
    }

    /**
     * MUD-IStore-compatible read. tableId is opaque routing and ignored; the key
     * is keyTuple[0]. Returns the MUD getRecord shape (staticData, encodedLengths,
     * dynamicData); the value is the dynamic field, which is all the client reads
     * (`hexToString(res[2])`). Empty value => dynamicData "" => client reads null.
     */
    function getRecord(bytes32, bytes32[] calldata keyTuple)
        external
        view
        returns (bytes memory staticData, bytes32 encodedLengths, bytes memory dynamicData)
    {
        return ("", bytes32(0), _value[keyTuple[0]]);
    }

    /// Convenience direct read (not used by the client, handy for tooling/tests).
    function get(bytes32 key) external view returns (bytes memory) {
        return _value[key];
    }
}
