// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title InferenceLedger — prepaid escrow + per-request voucher settlement, native AI3.
/// @notice Mirrors 0G Compute's couplings ② and ③ in one contract (they share the
///         balance storage):
///           ② prepaid ledger: deposit() → transferTo(provider) funds a per-(user,
///             provider) sub-account the provider can ONLY settle signed vouchers from;
///           ③ per-request vouchers: every inference request carries an EIP-712 voucher
///             signed by the USER's wallet (nonce, maxFee, expiry). Providers batch
///             `settle()` them — one signature check per request, one tx per batch.
///
///         v0 DECISIONS (spec 2026-07-05, ratified): native AI3 only — deposit() is
///         payable, fees are wei-of-AI3; no ERC-20 path, no approvals, no Permit2.
///
///         Refund design (provider protection, 0G-style): requestRefund() starts a
///         24h unlock window but the funds REMAIN SETTLEABLE until withdrawn — a
///         provider holding unsettled vouchers has the whole window to settle them
///         before the user can exit.
contract InferenceLedger {
    uint64 public constant REFUND_UNLOCK = 24 hours;

    // ── EIP-712 ──────────────────────────────────────────────────────────────
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address user,address provider,uint128 nonce,uint256 maxFee,uint64 expiry)");
    // secp256k1 half order — reject malleable high-s signatures
    uint256 private constant SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public immutable DOMAIN_SEPARATOR;

    struct Voucher {
        address user;      // the payer (signature must recover to this)
        address provider;  // the service being paid (must be msg.sender at settle)
        uint128 nonce;     // per-(user,provider) bitmap slot — replay guard
        uint256 maxFee;    // wei-of-AI3 cap this single request may cost
        uint64 expiry;     // unix seconds; voucher unusable after
    }

    struct Refund { uint256 amount; uint64 releaseAt; }

    mapping(address => uint256) public unallocated;                          // user → free funds
    mapping(address => mapping(address => uint256)) public balanceOf;        // user → provider → escrowed
    mapping(address => uint256) public accrued;                              // provider → settled earnings
    mapping(address => mapping(address => Refund)) public refunds;           // user → provider → pending exit
    mapping(address => mapping(address => mapping(uint256 => uint256))) private _nonceBitmap; // user → provider → word → bits

    event Deposited(address indexed user, uint256 amount);
    event TransferredTo(address indexed user, address indexed provider, uint256 amount);
    event UnallocatedWithdrawn(address indexed user, uint256 amount);
    event RefundRequested(address indexed user, address indexed provider, uint256 amount, uint64 releaseAt);
    event RefundWithdrawn(address indexed user, address indexed provider, uint256 amount);
    event Settled(address indexed user, address indexed provider, uint128 nonce, uint256 fee);
    event ProviderWithdrawn(address indexed provider, uint256 amount);

    error ZeroAmount();
    error Insufficient(uint256 have, uint256 want);
    error LengthMismatch();
    error NotVoucherProvider(address expected, address got);
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    error VoucherExpired(uint64 expiry, uint256 nowTs);
    error BadSignature();
    error NonceUsed(uint128 nonce);
    error RefundLocked(uint64 releaseAt, uint256 nowTs);
    error NothingToWithdraw();
    error SendFailed();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256("AIGGInferenceLedger"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ── ② the prepaid ledger ─────────────────────────────────────────────────
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        unallocated[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// fund the (msg.sender, provider) sub-account from free funds.
    function transferTo(address provider, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 free = unallocated[msg.sender];
        if (free < amount) revert Insufficient(free, amount);
        unallocated[msg.sender] = free - amount;
        balanceOf[msg.sender][provider] += amount;
        emit TransferredTo(msg.sender, provider, amount);
    }

    /// free funds never escrowed to anyone leave instantly (no lock — no provider
    /// holds vouchers against them).
    function withdrawUnallocated(uint256 amount) external {
        uint256 free = unallocated[msg.sender];
        if (amount == 0 || free < amount) revert Insufficient(free, amount);
        unallocated[msg.sender] = free - amount;
        emit UnallocatedWithdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    /// start (or top up) an exit from a provider sub-account. Funds stay settleable
    /// through the window; withdrawRefund() pays min(requested, remaining) after it.
    function requestRefund(address provider, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender][provider];
        if (bal < amount) revert Insufficient(bal, amount);
        Refund storage r = refunds[msg.sender][provider];
        r.amount += amount;
        if (r.amount > bal) r.amount = bal;                    // never exit more than escrowed
        r.releaseAt = uint64(block.timestamp) + REFUND_UNLOCK; // topping up restarts the clock
        emit RefundRequested(msg.sender, provider, r.amount, r.releaseAt);
    }

    function withdrawRefund(address provider) external {
        Refund memory r = refunds[msg.sender][provider];
        if (r.amount == 0) revert NothingToWithdraw();
        if (block.timestamp < r.releaseAt) revert RefundLocked(r.releaseAt, block.timestamp);
        uint256 bal = balanceOf[msg.sender][provider];
        uint256 pay = r.amount < bal ? r.amount : bal;         // settles during the window shrink it
        if (pay == 0) revert NothingToWithdraw();
        delete refunds[msg.sender][provider];
        balanceOf[msg.sender][provider] = bal - pay;
        emit RefundWithdrawn(msg.sender, provider, pay);
        (bool ok, ) = msg.sender.call{value: pay}("");
        if (!ok) revert SendFailed();
    }

    // ── ③ voucher settlement ─────────────────────────────────────────────────
    /// batch-settle signed vouchers. `fees[i]` is the METERED cost of request i
    /// (tokens × registry prices, computed off-chain) — capped by the user-signed
    /// maxFee, so a provider can never take more than the user authorized.
    function settle(Voucher[] calldata vs, bytes[] calldata sigs, uint256[] calldata fees) external {
        if (vs.length != sigs.length || vs.length != fees.length) revert LengthMismatch();
        uint256 total;
        for (uint256 i = 0; i < vs.length; i++) {
            Voucher calldata v = vs[i];
            uint256 fee = fees[i];
            if (v.provider != msg.sender) revert NotVoucherProvider(v.provider, msg.sender);
            if (fee > v.maxFee) revert FeeAboveMax(fee, v.maxFee);
            if (block.timestamp > v.expiry) revert VoucherExpired(v.expiry, block.timestamp);
            if (_recover(v, sigs[i]) != v.user) revert BadSignature();
            _useNonce(v.user, msg.sender, v.nonce);
            uint256 bal = balanceOf[v.user][msg.sender];
            if (bal < fee) revert Insufficient(bal, fee);
            balanceOf[v.user][msg.sender] = bal - fee;
            total += fee;
            emit Settled(v.user, msg.sender, v.nonce, fee);
        }
        accrued[msg.sender] += total;
    }

    function providerWithdraw() external {
        uint256 amount = accrued[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        accrued[msg.sender] = 0;
        emit ProviderWithdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    function voucherDigest(Voucher calldata v) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            DOMAIN_SEPARATOR,
            keccak256(abi.encode(VOUCHER_TYPEHASH, v.user, v.provider, v.nonce, v.maxFee, v.expiry))
        ));
    }

    function nonceUsed(address user, address provider, uint128 nonce) external view returns (bool) {
        return _nonceBitmap[user][provider][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function _useNonce(address user, address provider, uint128 nonce) internal {
        uint256 word = nonce >> 8;
        uint256 bit = 1 << (nonce & 0xff);
        uint256 bits = _nonceBitmap[user][provider][word];
        if (bits & bit != 0) revert NonceUsed(nonce);
        _nonceBitmap[user][provider][word] = bits | bit;
    }

    function _recover(Voucher calldata v, bytes calldata sig) internal view returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r; bytes32 s; uint8 vv;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            vv := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N) revert BadSignature();  // reject malleable high-s
        if (vv != 27 && vv != 28) revert BadSignature();
        address signer = ecrecover(voucherDigest(v), vv, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
