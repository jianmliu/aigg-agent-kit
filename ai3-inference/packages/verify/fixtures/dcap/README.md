# DCAP verifier fixtures

Known-good Intel TDX v4 quote + matching Intel PCS collateral, taken verbatim
from [Phala-Network/dcap-qvl](https://github.com/Phala-Network/dcap-qvl)
`sample/tdx_quote` and `sample/tdx_quote_collateral.json` (MIT license).

- `tdx_quote.bin` — a real TDX quote (version 4, tee_type 0x81). Verifies
  `UpToDate` against the collateral at any `now` inside the collateral's TCB
  validity window; the tests pin `now = 2025-06-25T00:00:00Z`
  (`DCAP_FIXTURE_NOW = 1750809600`).
- `tdx_quote_collateral.json` — the recorded collateral (PCK CRL chain, TCB
  info, QE identity) in dcap-qvl's `QuoteCollateral` JSON shape.

Known-bad cases are derived in the tests by mutating the TD report bytes
(signature breaks) and by moving `now` past the collateral expiry — no
separate bad blob is committed.
