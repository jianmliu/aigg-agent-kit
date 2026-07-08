// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ServiceRegistry — the on-chain "yellow pages" of the Auto EVM provider market.
/// @notice Mirrors 0G Compute's coupling ①: permissionless listing of inference services
///         (provider address → models, endpoint, per-token AI3 prices, attested enclave
///         signer). Discovery + pricing become public data instead of a platform DB row.
///
///         v0 DECISIONS (spec 2026-07-05, ratified):
///           • prices are wei-of-AI3 per token (native coin — no ERC-20 anywhere);
///           • NO staking, NO slashing — only an optional flat, refundable registration
///             bond (spam deterrence). Provider misbehavior is already economically
///             bounded by the voucher design (see InferenceLedger); quality signals
///             (verify rate, latency) belong to the client layer.
///
///         Attestation is verified CLIENT-SIDE (0G's design): the chain stores only the
///         enclave's response-signing address + the hash of its attestation quote (the
///         quote blob itself lives on DSN). Clients check the quote once, then plain
///         ECDSA per response.
contract ServiceRegistry {
    struct Service {
        string endpoint;         // https gateway URL
        string[] models;         // e.g. ["gpt-5", "claude-opus-4-8"]
        uint256 inputPriceWei;   // wei-of-AI3 per input token
        uint256 outputPriceWei;  // wei-of-AI3 per output token
        bytes32 attestationRef;  // keccak256 of the dstack quote blob (blob on DSN)
        address attestedSigner;  // enclave-generated response-signing key
        string verifiability;    // honest label, e.g. "dstack-cvm-relay" (NEVER "inference")
        uint64 updatedAt;
        bool active;
    }

    /// flat, refundable listing bond (0 = disabled). Fixed at deploy — no governance.
    uint256 public immutable bondWei;

    mapping(address => Service) internal _services;
    address[] public providers;                 // append-only enumeration (may hold inactive)
    mapping(address => bool) internal _known;   // provider ever registered

    event Registered(address indexed provider, string endpoint, uint256 inputPriceWei, uint256 outputPriceWei, address attestedSigner);
    event Updated(address indexed provider, string endpoint, uint256 inputPriceWei, uint256 outputPriceWei, address attestedSigner, bytes32 attestationRef);
    event Deactivated(address indexed provider);

    error WrongBond(uint256 sent, uint256 required);
    error AlreadyActive();
    error NotActive();
    error BondRefundFailed();

    constructor(uint256 _bondWei) {
        bondWei = _bondWei;
    }

    /// list (or re-list) the caller's service. Pays the flat bond when enabled.
    function register(
        string calldata endpoint,
        string[] calldata models,
        uint256 inputPriceWei,
        uint256 outputPriceWei,
        bytes32 attestationRef,
        address attestedSigner,
        string calldata verifiability
    ) external payable {
        if (_services[msg.sender].active) revert AlreadyActive();
        if (msg.value != bondWei) revert WrongBond(msg.value, bondWei);
        _services[msg.sender] = Service({
            endpoint: endpoint,
            models: models,
            inputPriceWei: inputPriceWei,
            outputPriceWei: outputPriceWei,
            attestationRef: attestationRef,
            attestedSigner: attestedSigner,
            verifiability: verifiability,
            updatedAt: uint64(block.timestamp),
            active: true
        });
        if (!_known[msg.sender]) { _known[msg.sender] = true; providers.push(msg.sender); }
        emit Registered(msg.sender, endpoint, inputPriceWei, outputPriceWei, attestedSigner);
    }

    /// update any listing field (e.g. rotated enclave key after a CVM redeploy → new
    /// attestationRef + attestedSigner). Active listings only.
    function update(
        string calldata endpoint,
        string[] calldata models,
        uint256 inputPriceWei,
        uint256 outputPriceWei,
        bytes32 attestationRef,
        address attestedSigner,
        string calldata verifiability
    ) external {
        Service storage s = _services[msg.sender];
        if (!s.active) revert NotActive();
        s.endpoint = endpoint;
        s.models = models;
        s.inputPriceWei = inputPriceWei;
        s.outputPriceWei = outputPriceWei;
        s.attestationRef = attestationRef;
        s.attestedSigner = attestedSigner;
        s.verifiability = verifiability;
        s.updatedAt = uint64(block.timestamp);
        emit Updated(msg.sender, endpoint, inputPriceWei, outputPriceWei, attestedSigner, attestationRef);
    }

    /// delist and reclaim the bond.
    function deactivate() external {
        Service storage s = _services[msg.sender];
        if (!s.active) revert NotActive();
        s.active = false;
        s.updatedAt = uint64(block.timestamp);
        emit Deactivated(msg.sender);
        if (bondWei > 0) {
            (bool ok, ) = msg.sender.call{value: bondWei}("");
            if (!ok) revert BondRefundFailed();
        }
    }

    // ── views ────────────────────────────────────────────────────────────────
    function getService(address provider) external view returns (Service memory) {
        return _services[provider];
    }

    function providerCount() external view returns (uint256) {
        return providers.length;
    }

    /// paged listing for clients (listService analogue). Includes inactive entries —
    /// callers filter on .active.
    function list(uint256 offset, uint256 limit) external view returns (address[] memory addrs, Service[] memory svcs) {
        uint256 n = providers.length;
        if (offset >= n) return (new address[](0), new Service[](0));
        uint256 end = offset + limit;
        if (end > n) end = n;
        addrs = new address[](end - offset);
        svcs = new Service[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            addrs[i - offset] = providers[i];
            svcs[i - offset] = _services[providers[i]];
        }
    }
}
