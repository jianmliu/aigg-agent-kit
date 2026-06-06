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
 * Permissionless by design: anyone can write any key (openAccess). Cross-server
 * trust comes from content-addressing (a head CID names an immutable blob) plus
 * application-level ownership inside the stored value, not from write gating.
 */
contract KvWorld {
    // selector routing for World.call(systemId, callData)
    bytes4 private constant KV_SET = bytes4(keccak256("kvSet(bytes32,bytes)"));
    bytes4 private constant KV_DEL = bytes4(keccak256("kvDel(bytes32)"));

    mapping(bytes32 => bytes) private _value;

    event KvSet(bytes32 indexed key, bytes value);
    event KvDel(bytes32 indexed key);

    /**
     * MUD-World-compatible entry point. `MudWorldKvClient` routes writes here as
     * World.call(systemId, callData). systemId is opaque routing and ignored —
     * this World hosts exactly one (KvSystem) surface.
     */
    function call(bytes32, bytes calldata callData) external payable returns (bytes memory) {
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
