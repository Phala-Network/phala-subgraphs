# Phala subgraphs

Two Goldsky subgraphs share the mappings in this repository:

| Manifest / deployment              | Indexed data                                                        | Token / start block                                     | Clock interval |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- | -------------- |
| `ethereum.yaml` / `phala-ethereum` | PHA circulation, Vault metrics and flows, Khala/Phala sunset claims | `0x6c5ba91642f10282b576d91922ae6448c9d52f4e` / 9975568  | 25 blocks      |
| `base.yaml` / `phala-base`         | Base PHA circulation                                                | `0x336c9297afb7798c292e9f80d8e566b947f291f0` / 12743284 | 150 blocks     |

Consumers use the `prod` tag:
`https://api.goldsky.com/api/public/project_cmdgxxcewrqdi01wx9e7md0ek/subgraphs/<name>/prod/gn`.
See the circulation server's
[operations guide](https://github.com/Phala-Network/pha-circulation-server/blob/main/docs/OPERATIONS.md)
for the wider stack.

## Data reference

[schema.graphql](./schema.graphql) defines the complete GraphQL contract. Token
amounts are integer **wei** (18 decimals); timestamps are Unix seconds.
`sharePrice` and `apr` are `BigDecimal` strings: assets / shares and an annual
fraction, respectively. Both are zero without shares; APR is also zero when
paused, assets are zero, or the implementation is unreviewed.

| Entity                     | Fields and meaning                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChainState`, `VaultState` | Mutable accumulators, singleton `current`                                                                                                                                              |
| `Latest`                   | Singleton `current`: circulation components, Vault assets/locked amount, `shareSupply`, `sharePrice`, `apr`, `stakers`, and implementation status; refreshed on events and Clock polls |
| `ChainDay`                 | Immutable midnight circulation components; ID and `date` are `YYYY-MM-DD`                                                                                                              |
| `VaultDay`                 | Immutable midnight Vault metrics and preceding-day flow totals; see below                                                                                                              |
| `ClaimDay`                 | Preceding-day `khalaClaimCount`, `khalaFree`, `khalaStaked`, `phalaClaimCount`, `phalaFree`, `phalaStaked`                                                                             |
| `Transfer`                 | PHA logs touching S: `from`, `to`, `amount`, block/time, transaction hash and log index; each log stored once                                                                          |
| `VaultEvent`               | Vault log kind, assets/shares, raw `settlementAssets`, block/time and transaction/log identity; `unstakeLockedAfter` follows log order, checkpoint fields are end-of-block reads       |
| `Holder`                   | Share balance by address, including zero balances; `stakers` counts positive balances excluding the zero address                                                                       |
| `Claimed`                  | Khala claims only; legacy no-code schema                                                                                                                                               |
| `ClaimedAndBridged`        | Phala claims only; legacy no-code schema                                                                                                                                               |

Claimer entities preserve nullable event parameters, lowercase string addresses,
`contractId_`, `transactionHash_`, `timestamp_`, `block_number`, and string IDs
`<transaction hash>-<block log index>`. Khala uses `receiver`; Phala uses
`l1Receiver` / `l2Receiver`. Apps' `where: {user: $user}` queries retain their
existing shape. The Phala claimer's empty `Claimed` event stream is not mapped.

### Snapshot and flow dates

`ChainDay` evaluates balances and Vault accrual **exactly at 00:00 UTC**, before
events at that timestamp. Deployment-day midnight has zero supply. Each handler
calls `closeDaysUpTo` before applying its event; Clock polls close quiet days.

`observedBlockNumber` / `observedBlockTimestamp` identify the last event or poll
before closure, not the final canonical block before midnight. They are zero
before deployment. Snapshot consumers retain this observed-block meaning and
the requested midnight `date`. The legacy `/api/snapshot` instead reads the
first block at or after midnight, explaining small parity differences.

| VaultDay field                                                 | Meaning                                                                    | Dune equivalent |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------- |
| `date`, `timestamp`                                            | Midnight snapshot boundary                                                 | —               |
| `totalAssets`, `treasuryAssets`                                | Accrued assets at midnight                                                 | —               |
| `shareSupply`, `sharePrice`, `apr`, `stakers`, `unstakeLocked` | Midnight staking metrics                                                   | —               |
| `flowDate`                                                     | Previous UTC day; flows cover `[flowDate 00:00, date 00:00)`               | `day`           |
| `settlementTotalAssets`                                        | Last `RewardsSettled.totalAssets` in `flowDate`, null without a settlement | `totalAssets`   |
| `dailyRewards`                                                 | Sum of `RewardsSettled.rewards` in `flowDate`                              | `dailyRewards`  |
| `dailyTreasuryRewards`, `treasurySettlementCount`              | Treasury settlement amount and count                                       | —               |
| `deposits`, `withdrawRequests`, `claims`, `treasuryClaims`     | Event asset sums; deposits include cancelled unstake redeposits            | —               |
| `depositCount`, `withdrawRequestCount`, `claimCount`           | Corresponding event counts                                                 | —               |

`ClaimDay` uses the same `date` / `flowDate` convention. Vault days begin at the
first midnight after initialization; claim days begin after the first claim.
Gap days have zero flows and null `settlementTotalAssets`.

### Circulation

Each chain stores `totalSupply`, the balances below, and `circulation`.
Ethereum also exposes `vaultTotalAssets`, `vaultTreasuryAssets`,
`vaultUnstakeLocked` and `vaultReward`.

| Component                | Address                                      | Chains   |
| ------------------------ | -------------------------------------------- | -------- |
| `reward`                 | `0x4731bc41b3cca4c2883b8ebb68cb546d5b3b4dd6` | Both     |
| `phalaChainBridge`       | `0xcd38b15a419491c7c1238b0659f65c755792e257` | Both     |
| `khalaLegacyChainBridge` | `0x6ed3bc069cf4f87de05c04c352e8356492ec6efe` | Both     |
| `khalaChainBridge`       | `0xeec0fb4913119567cdfc0c5fc2bf8f9f9b226c2d` | Both     |
| `sygmaBridge`            | `0xc832588193cd5ed2185dada4a531e0b26ec5b830` | Both     |
| `portalBridge`           | `0x3ee18b2214aff97000d974cf647e7c347e8fa585` | Both     |
| `sunsetReward`           | `0x4a396b5c9a6fbc1bc0525f24ac0a246766f3ebef` | Ethereum |
| `vaultBalance`           | `0x21d6ec8fc14caacc55afa23cba66798dab3a0ec0` | Ethereum |

S contains these addresses plus `0x0000000000000000000000000000000000000000`
for mint/burn supply accounting. Two data sources filter `topic1 ∈ S` and
`topic2 ∈ S`; each updates its own side, while the From handler stores the audit
row when both match. Filtered Transfers also support per-bridge flow queries.

```text
khalaBridge = khalaLegacyChainBridge + khalaChainBridge
vaultReward = vaultBalance - vaultTotalAssets - vaultTreasuryAssets - vaultUnstakeLocked
ethereumCirculation = totalSupply - reward - sunsetReward - phalaChainBridge
                      - khalaBridge - sygmaBridge - portalBridge - vaultReward
baseCirculation = totalSupply - reward - phalaChainBridge - khalaBridge
                  - sygmaBridge - portalBridge
```

`vaultReward` may be negative when promised rewards exceed funding. Historical
Substrate Phala/Khala circulation remains a frozen archive; Phala L2 vPHA is
outside this formula.

### Vault accrual and upgrades

Every Vault event declares reads of the seven accrual getters. The
[verified implementation](https://sourcify.dev/server/v2/contract/1/0xC0b39989381D8C88b7ef82A80d4C90540E70862A?fields=all)
uses basis points and floors the treasury share first:

```text
rewards = paused || shareSupply == 0 ? 0 : rewardRate * (T - checkpointTime)
treasuryRewards = floor(rewards * treasuryRatio / 10000)
totalAssets(T) = checkpointTotalAssets + rewards - treasuryRewards
treasuryAssets(T) = checkpointTreasuryAssets + treasuryRewards
APR = rewardRate * (1 - treasuryRatio / 10000) * 31536000 / totalAssets
```

`Withdraw` increases locked PHA; `Claimed` decreases it. `Deposit` decreases it
only when `sender == Vault`. `TreasurySettled` and `TreasuryAssetsClaimed` are
separate flows. Contract reads are end-of-block values; locked assets and Holder
balances follow log order.

`vaultImplementation`, `vaultImplementationReviewed` and `accrualMode` appear
on `Latest`, `ChainDay` and `VaultDay` (`VaultState` names the address
`implementation`). The reviewed implementation is
`0xC0b39989381D8C88b7ef82A80d4C90540E70862A`.

Unknown implementations set `vaultImplementationReviewed=false` and
`accrualMode="checkpoint-only"`: assets use checkpoint values, APR is zero,
and token/claimer indexing continues. Missing getters retain the last complete
checkpoint. Future checkpoint times or treasury ratios above 10000 trigger the
same fallback, including logs before `Upgraded` that read the new end-of-block
getters. Before Vault deployment and on Base, the implementation is zero,
reviewed is true, and mode is `inactive`.

Consumers should treat an unreviewed implementation as unhealthy;
pha-circulation-server returns 503 for circulation. The parity runner rejects
promotion while the flag is false.

For an upgrade, review the verified ABI and formula, update the ABI and
implementation allowlist/formula dispatch, deploy a new version, verify features
and parity, then move `prod`. Changing a consumer flag does not validate accrual.

## Development

Use Bun **1.4.2** and Node.js **20.18.1+**. Dependencies are exact pins in the
text `bun.lock`.

```bash
bun install --frozen-lockfile
bun run codegen       # both manifests, Ethereum first for Vault bindings
bun run build         # build/ethereum and build/base
bun run test          # matchstick 0.6.0
bun run test:verify   # offline parity fixtures
bun run typecheck     # parity scripts; mappings compile during build
bun run check         # Biome CI
```

Matchstick's Linux binary needs `libpq.so.5` (`libpq5` on Ubuntu 22/24); CI
installs it in the runner. Docker is also supported:
`bunx --no-install graph test -d -v 0.6.0`. Biome formats AssemblyScript while
leaving its lint/import checks to the mapping compiler.

## Deploy, tag and rollback

Use Goldsky's **Scale free allowance**: **2,250 worker-hours/month**, **~100K
entities**, and **at most three active subgraphs team-wide**, including temporary
versions. Check storage after sync. Starter has a one-time credit and can pause
services when exhausted.

1. Pause the legacy `phala-claimer/1.0.0` and `khala-claimer/1.0.0`; keep
   `phala-vault-state` active for the circulation server. Paused subgraphs serve
   stale GraphQL data; claims made during the pause appear after apps switch to
   the new subgraph. Save each claimer's `_meta.block`. Keep pauses to **days**:
   an extended pause risks permanent deletion by Goldsky.
2. Deploy a temporary short-range feature test, verify topic filters, declared
   calls and Clock polling, then **delete it immediately**. Observe
   `_meta.hasIndexingErrors=false`, Vault checkpoints and `Latest.timestamp`
   advancing through a quiet polling interval. Keep test start blocks and
   accumulator dates consistent; this is not a historical parity candidate.
3. Deploy both full manifests without a graft. Active total: legacy vault-state
   plus the two new subgraphs = three. Goldsky uses the compiled directories'
   `subgraph.yaml`:

   ```bash
   bun run codegen
   bun run build
   goldsky subgraph deploy phala-ethereum/1.0.0 --path build/ethereum
   goldsky subgraph deploy phala-base/1.0.0 --path build/base
   ```

4. Wait for full sync and run the subgraph parity checks below. Finish gate 1
   **before switching `/api/snapshot` to the new subgraphs**, always with
   `--snapshot-cache`. Vault checkpoints use active vault-state; each claimer
   comparison uses its paused last indexed block. Then tag:

   ```bash
   goldsky subgraph tag create phala-ethereum/1.0.0 --tag prod
   goldsky subgraph tag create phala-base/1.0.0 --tag prod
   ```

5. Delete legacy vault-state after the circulation server cutover is verified;
   delete the paused claimers after the apps cutover is verified. Before
   deletion, rollback resumes the old subgraph and reverts its consumer, pausing
   replacements as needed to stay within three active subgraphs. After deletion,
   rollback requires redeploying and resyncing.

For subsequent upgrades, use the spare third slot for one replacement at a time:
deploy, verify, move its tag, delete its old version, then update the other chain.
`prune: auto` retains immutable daily/event history and prunes old mutable
versions; verification filters immutable rows by reference block instead of
querying historical mutable state. CI does not deploy or move tags.

## Parity verification

The runner exits nonzero on failure and writes a JSON report. Inputs come from
arguments/environment; it does not load secret files. Set `GOLDSKY_ETHEREUM_URL`
and `GOLDSKY_BASE_URL` to synced version endpoints, `SNAPSHOTS_NDJSON` to the
1,825-row snapshot archive, and `DUNE_RESULTS_JSON` to the Dune `results.json`.

```bash
mkdir -p /tmp/phala-parity
bun run verify --stage subgraphs --snapshot-cache /tmp/phala-parity/snapshots.ndjson \
  --output /tmp/phala-parity/subgraphs.json
bun run verify --stage server --preview "$SERVER_PREVIEW_URL" \
  --output /tmp/phala-parity/server.json
bun run verify --stage cache --d1-json "$D1_EXPORT_JSON" \
  --output /tmp/phala-parity/cache.json
```

Always preserve the snapshot cache from **before the circulation API cutover**;
otherwise the reference could read the same new data. Cached reads resume the
sequential old-API scan, which can take hours; requests are paced to four/second.

- `subgraphs`, gates 1–2: every date from 2020-04-30, exact exposed snapshot
  components; first-block differences require audited flows on at most 1% of
  dates. Vault accrual residual is bounded by `midnight rewardRate * delay + 1e-6 PHA`.
- Gate 3: 1,825 archived snapshots and 365 History totals, relative tolerance
  `1e-7`; larger differences need a passing snapshot explanation.
- Gate 4: exactly 550 Dune settlement days through 2026-10-10, assets/rewards
  tolerance `1e-12`; event-based settlement/reward/flow residuals must be zero.
- Gates 5–6: exact legacy Vault checkpoints and complete claimer ID/field sets
  at each old claimer's last block; the new indexer must reach both. Old Phala
  `claimeds` stays empty.
- `server`, gate 7: endpoint keys/types, current circulation tolerance `1e-6`,
  and 30 snapshot dates equal ChainDay. Source metadata replaces
  `headBlockNumber`/`lagBlocks` with `indexedAt`/`lagSeconds`.
- `cache`, gate 8: daily row counts and latest totals within `1e-9`; all 663
  archived Cloud rows, including `captured`, exact.

The old API merges Ethereum's Khala bridge balances and exposes only supply and
circulation for Base. The Vault assets+treasury check is derived from old
`vaultReward` and audited flows. Dune has 550 dated assets but daily rewards only
for 2026-10-10 (`34930.0634765625` PHA); the report lists the other 549 dates as
unavailable, not zero. Undated summary rows are excluded.

Optional raw checks use `ARCHIVE_RPC_URL` / `BASE_ARCHIVE_RPC_URL` (or
`--archive-rpc` / `--base-archive-rpc`): 30 deterministic dates per configured
chain, including endpoints and prioritizing first-block S transfers. All raw
balances/supply are checked at observed blocks; Ethereum assets are evaluated
at the observed block's timestamp. Unconfigured checks report skipped. These
are verification-only reads through the viem dev dependency.

The cache input is a JSON object containing `circulation_day`, `vault_day`,
`claim_day` and `cloud_daily` arrays. Preserve `date` / `chain`; normalize metric
keys to Graph fields, amounts to PHA decimals and counts to integers. Keep Cloud
`total_users`, `total_vms`, `running_vms`, `total_vcpu`, `captured` verbatim.

`--stage all` requires all inputs. Endpoint/archive overrides are `--ethereum`,
`--base`, `--ndjson`, `--results`, `--old-api`, `--old-vault`, `--old-khala`,
`--old-phala`; `--samples N` changes raw sampling. `SERVER_PREVIEW_URL` and
`D1_EXPORT_JSON` work without flags. Default old references are the public
circulation API and the legacy Goldsky subgraphs in the same project.
