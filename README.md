# AgriCast Oracle Reporter

A standalone reporter node for AgriOracle, the price oracle behind AgriCast's Thai
agricultural-commodity prediction markets. Run this to stake ETH, sign and submit price
reports, and earn rewards for accurate reporting.

This is a single-hot-key node: one reporter identity per running instance. Run more than one
instance (different keys) if you want to operate several reporters.

## What this does NOT do

This node has no access to AgriCast's internal database. For prices, it scrapes
data.moc.go.th (Thailand's Ministry of Commerce) itself via `src/moc-scraper.ts` - an
independent read, not a trust-the-backend relay - falling back to a URL you configure
(`PRICE_SOURCE_URL`) only if that direct scrape fails or is disabled. It discovers reportable
markets from a second URL you configure (`MARKETS_API_URL`). The contract does not care where
your data comes from; it only cares whether your reported price agrees with the stake-weighted
median of everyone else's.

## Quickstart

```bash
npm install
cp .env.example .env
# edit .env: REPORTER_PRIVATE_KEY, RPC_URL, CHAIN_ID, ORACLE_ADDRESS (or fill src/addresses.json),
# PRICE_SOURCE_URL, MARKETS_API_URL

npm run cli status      # confirm the domain-separator check passes and read your on-chain state
npm run cli register    # stake MIN_STAKE + REGISTRATION_FEE and register
npm start                # run the poll loop
```

Use a testnet (Sepolia) first. Do not point a fresh reporter at production without a dry run.

## Lifecycle

1. **Register** - `cli register` stakes `MIN_STAKE` + `REGISTRATION_FEE` and adds you to the
   reporter set.
2. **Submit** - the poll loop (`npm start`) discovers markets past their resolution time,
   fetches a price, EIP-712-signs it, and calls `submitReport` with a `REPORT_BOND` bond. The
   same key signs and sends - the contract requires `signer == msg.sender`.
3. **Settle** - once the reporting window closes (and quorum is met), anyone can call
   `cli settle <questionId>` to compute the stake-weighted median. If quorum falls short the
   window auto-extends once, then the question is marked failed and needs an admin recovery
   path.
4. **Resolve** - `resolveBinaryMarket` / `resolveMultiBracketMarket` turn the median into a
   payout vector. These are `RESOLVER_ROLE`-gated - a public reporter cannot call them unless
   granted that role by the contract's admin.
5. **Dispute window** - anyone (a registered reporter, or admin) can `cli dispute <questionId>`
   within the dispute period, posting a bond.
6. **Finalize** - after the dispute period (or once a dispute is resolved), `cli finalize
   <questionId>` applies the deferred slash/reward against whichever price actually stood -
   the original median, or a dispute-corrected one.
7. **Unbond / claim** - `cli withdraw` or `cli unregister` queue your stake for a 7-day
   unbonding period; `cli claim` pays it out once that period has passed and you have no
   unsettled reports outstanding.

## Economics

AgriOracle is an EIP-2535 diamond: one permanent proxy address routes calls to swappable
facets, so `ORACLE_ADDRESS` never changes across a facet upgrade. Values below are the
contract's constants (`contracts/src/oracle/libraries/OracleConstants.sol`, read through
`OracleViewFacet`) as of this repo's ABI snapshot - `npm run cli status` also prints your live
on-chain numbers so you never have to trust these being current.

| Constant | Value | Meaning |
|---|---|---|
| `MIN_STAKE` | 1 ETH | minimum stake to register |
| `REGISTRATION_FEE` | 0.01 ETH | non-refundable, paid once at registration, funds the reward pool |
| `ACTIVE_THRESHOLD` | 0.5 ETH | stake floor to submit reports; falls here after a slash and you stop earning until topped up |
| `REPORT_BOND` | 0.1 ETH | posted per `submitReport` call, returned if accurate, forfeited if not |
| `SLASH_AMOUNT` | 0.10 ETH | cut from stake when your report deviates more than 5% from the final settlement value |
| `REWARD_AMOUNT` | 0.01 ETH | paid on top of the returned bond for an accurate report, only if the free reward pool can cover it |
| `DEVIATION_THRESHOLD_BPS` | 500 (5%) | deviation from the final price that triggers a slash instead of a reward |
| `UNBOND_PERIOD` | 7 days | cooldown before withdrawn/unregistered stake is claimable |
| `QUORUM_MIN_STAKE` / `QUORUM_MIN_REPORTERS` | 5 ETH / 3 | minimum snapshot weight and distinct reporters before a question can settle |
| `DISPUTE_BOND_MIN` / `DISPUTE_BOND_BPS` | 0.2 ETH / 2% | dispute bond floor, or 2% of declared market collateral if higher |
| `DISPUTE_REWARD` | 0.02 ETH | paid to a disputer whose dispute is upheld |

Slash/reward is deferred to finalization, not applied when the median is first computed - so a
successful dispute can still claw back an unjust slash before it's paid out.

## Trust model

AgriOracle is not "trustless" in the sense of not needing honest participants - it is
economically enforced: reporters have real ETH at risk, and dishonest reports lose money
against the stake-weighted median while honest ones earn a small reward. Read that carefully:
**the contract does not validate your data source.** It only checks that your signature is
valid, your stake is active, and your reported price agrees with everyone else's within
tolerance. If you configure `PRICE_SOURCE_URL` to point at garbage, you will either get
outvoted and slashed (if you're a minority) or, in the worst case, help move a market's
settlement price if enough stake-weighted reporters collude - the sybil resistance model
assumes voting power is linear in stake and that stake is genuinely at risk across the full
dispute horizon, not that any individual reporter is trustworthy.

Before you point your own price feed at production, understand what you're vouching for.

## Safety

- Use a dedicated hot wallet for `REPORTER_PRIVATE_KEY`. Never reuse a wallet that holds other
  funds - this key signs and sends transactions unattended in the poll loop.
- Never commit `.env`. Only `.env.example` (placeholder values) belongs in git; `.gitignore`
  already excludes `.env` and `.env.local`.
- Test on Sepolia before running against production. `NETWORK=sepolia` in `.env.example` is the
  default for a reason.
- If you suspect your key leaked, run `cli invalidate-nonce` immediately (invalidates every
  outstanding unsubmitted signature), then `cli unregister` to start the unbonding clock on
  your stake, and rotate the key.
- `AUTO_TOPUP=false` by default - the poll loop will not spend ETH on your behalf unless you
  opt in. Every CLI command that spends ETH prints the amount and asks for confirmation
  (`--yes` to skip, for scripting).

## Auto-enroll (demo)

`AUTO_ENROLL=true` makes the node self-register on startup instead of requiring the explicit
`cli register` command - useful for a docker-compose demo where this node runs as a 4th
reporter and should come up already staked. It runs once, after the abi-drift-guard
domain-separator check and before the poll loop starts:

- Not registered yet: registers with `AUTO_ENROLL_STAKE` ETH (falls back to the contract's
  `MIN_STAKE` if unset, or if set below `MIN_STAKE`) plus `REGISTRATION_FEE`. First checks the
  wallet balance covers that total plus a small gas buffer - if it doesn't, the node logs an
  error and exits non-zero instead of looping unregistered.
- Registered but under `ACTIVE_THRESHOLD` (e.g. after a slash): tops the stake back up to the
  threshold so it can submit reports.
- Registered and active: logs and continues straight into the poll loop.

**This spends real ETH on first start** - at least `MIN_STAKE` (1 ETH) + `REGISTRATION_FEE`
(0.01 ETH) = 1.01 ETH, more if `AUTO_ENROLL_STAKE` is set higher. `AUTO_ENROLL=false` is the
default for exactly the reason `AUTO_TOPUP` is: this is a public node, and a node that spends a
wallet's ETH without an explicit command is not a safe default. Only opt in when you control the
wallet and mean for it to register unattended (e.g. a demo environment).

## Configuration reference

See `.env.example` for the full list. Price data comes from two layers:

- `MOC_ENABLED` (default `true`), `MOC_BASE_URL`, `MOC_REQUEST_TIMEOUT_MS`, `MOC_SCRAPE_ATTEMPTS`
  - the primary source. `src/moc-scraper.ts` drives headless Chromium against
  `data.moc.go.th/OpenData/GISProductPrice` for the given product, same site the backend's own
  scraper uses, and returns the latest available day. Requires Chromium in the image (installed
  by the `Dockerfile`).
- `PRICE_SOURCE_URL` - the fallback. Used only if the direct MOC scrape errors, times out, or
  `MOC_ENABLED=false`. `GET {url}?productCode=<code>` must return
  `{ "productCode": "...", "priceMin": number, "priceMax": number, "date": "ISO-8601" }`.
- `MARKETS_API_URL` - you must fill this in yourself, since this repo does not ship it.
  `GET {url}` must return
  `[{ "questionId": "0x...", "productCode": "...", "resolutionTime": "ISO-8601" }, ...]`.

`ORACLE_ADDRESS` in `.env` overrides `src/addresses.json` - fill in whichever one is convenient
for your setup. Both ship with placeholder `0x0...0` addresses; you must fill them in with the
diamond's permanent proxy address after the deploy you're targeting. If you fill in
`src/addresses.json` instead, also set `deployBlock` to the diamond's creation block (see the
comment in that file) - it bounds reporter event-log queries, so a stale value causes missed or
over-scanned events.

## Joining as a reporter (permissionless)

Registration is open to anyone: `registerReporter` carries no role restriction under the
protocol's AccessManager (all reporter-lifecycle calls - register, add/withdraw stake,
unregister, claim, invalidate-nonce - are `PUBLIC_ROLE` by default, unassigned to any of the
gated roles like `RESOLVER`/`REGISTRAR`/`APP_ADMIN`). There is no allowlist and no admin
approval step - stake `MIN_STAKE` + `REGISTRATION_FEE` (1.01 ETH at current constants) via
`cli register` and you're in. Only the state-changing admin/resolver/dispute-resolution paths
are role-gated; nothing on the join path is.

## abi-drift-guard

On startup, this node computes its local EIP-712 domain separator (from `src/abi/domain.ts`)
and compares it against the deployed contract's `getDomainSeparator()`. If they don't match, it
refuses to sign anything and exits with an error instead of burning gas on transactions that
would revert with "Invalid signature". If you see that error, this repo's ABI/domain snapshot
is stale relative to whatever contract you pointed it at - update `src/abi/AgriOracle.json` and
`src/abi/domain.ts` to match.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build        # compile to dist/
npm run dev           # tsx watch src/reporter.ts
```
