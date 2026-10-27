# Phala subgraphs

Two independent Goldsky subgraphs share the mappings in this repository:

| Manifest / deployment name         | Coverage                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `ethereum.yaml` / `phala-ethereum` | PHA circulation inputs, Vault state and flows, Khala and Phala sunset claims |
| `base.yaml` / `phala-base`         | Base PHA circulation inputs                                                  |

Consumers use each deployment's `prod` tag. This PR prepares the replacements;
no deployment, tag move, repository rename, or deletion is part of the change.
The existing `phala-vault-state`, `khala-claimer` and `phala-claimer` deployments
remain the rollback path until cutover and the subsequent seven-day soak.

[Specification and parity gates](./SPEC.md). The circulation server's
[OPERATIONS.md](https://github.com/Phala-Network/pha-circulation-server/blob/main/docs/OPERATIONS.md)
is the shared operations runbook for the stack.

## Data contract

Token amounts are integer **wei**, with 18 decimals. `sharePrice` and `apr` are
Graph `BigDecimal` strings: price is total assets / share supply; APR is a
fraction (multiply by 100 for percent). Both are zero with zero share supply;
APR is also zero when paused, when total assets are zero, or when the
implementation is unreviewed.

| Entity                     | Meaning                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ChainState`, `VaultState` | Internal mutable accumulators, singleton `current`                                                              |
| `Latest`                   | Current circulation components and Vault metrics, singleton `current`; refreshed on events and Clock polls      |
| `ChainDay`                 | Immutable circulation components at the date's exact 00:00 UTC; ID and `date` are `YYYY-MM-DD`                  |
| `VaultDay`                 | Immutable midnight Vault metrics, plus the preceding day's flow counters                                        |
| `ClaimDay`                 | Immutable preceding-day claim totals, separately for Khala and Phala                                            |
| `Transfer`                 | Immutable PHA logs touching S, stored once per transaction hash + log index                                     |
| `VaultEvent`               | Immutable Vault logs and cumulative `unstakeLockedAfter`; checkpoint fields are end-of-block contract reads     |
| `Holder`                   | Share balance by address, including zero balances; stakers counts positive balances, excluding the zero address |
| `Claimed`                  | **Khala only**, with the exact legacy no-code schema                                                            |
| `ClaimedAndBridged`        | **Phala only**, with the exact legacy no-code schema                                                            |

The claimer entities retain nullable event parameters, `contractId_`,
`transactionHash_`, `timestamp_`, `block_number`, and the string ID
`<transaction hash>-<block log index>`. Address fields remain lowercase strings,
so apps' `where: {user: $user}` queries continue to work. Phala's empty `Claimed`
entity is deliberately not mapped into the merged subgraph.

### Midnight snapshots and flow dates

**Convention change:** the old `/api/snapshot?date=YYYY-MM-DD` reads the first
block at or after midnight (or the token's deployment block on its first day).
`ChainDay` now evaluates balances and Vault accrual **exactly at 00:00 UTC**,
before events with that timestamp. Deployment-day midnight has zero supply,
even when a token's first Transfer occurs later. Quiet days are filled by
`closeDaysUpTo` before each event; the Clock closes days without recent events.

`observedBlockNumber` and `observedBlockTimestamp` are the **last block observed
before closure** (an event or poll), not a lookup of the final canonical block
before midnight. They are zero for the initial pre-deployment snapshot. After
PR2, the public snapshot API's block fields will carry this observed-block
meaning. Its `date` remains the requested midnight. Parity compares values,
not block numbers.

| VaultDay field                                             | Meaning                                                                       | Dune equivalent                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| `date`, `timestamp`                                        | Exact midnight snapshot boundary                                              | No direct equivalent                              |
| `totalAssets`, `treasuryAssets`                            | Accrued assets at that midnight                                               | No direct equivalent                              |
| `flowDate`                                                 | Previous UTC calendar day; flows cover `[flowDate 00:00, date 00:00)`         | `day`                                             |
| `settlementTotalAssets`                                    | Last `RewardsSettled.totalAssets` in `flowDate`, null if no settlement        | `totalAssets`                                     |
| `dailyRewards`                                             | Sum of `RewardsSettled.rewards` in `flowDate`                                 | `dailyRewards` (only one dated value is archived) |
| `dailyTreasuryRewards`, `treasurySettlementCount`          | Treasury settlement amount and count in `flowDate`                            | Not exported                                      |
| `deposits`, `withdrawRequests`, `claims`, `treasuryClaims` | Event asset sums in `flowDate`; deposits include cancelled unstake redeposits | Not exported                                      |

`ClaimDay.date` / `flowDate` follow the same convention. Vault days begin at the
first midnight after Vault initialization; claim days begin after the first
claim. Gap days have zero flows and a null `settlementTotalAssets`.

### Circulation and Vault math

The addresses in S match `pha-circulation-server`'s `src/chain.ts`: the reward
account, both Khala bridges, the Phala bridge, Sygma, Portal, and zero address;
Ethereum additionally includes the sunset reward account and the Vault.
`src/constants.ts` and the manifests contain their exact addresses. Two token
data sources filter `topic1 ∈ S` and `topic2 ∈ S`. Each changes only its own
side; the From handler owns the audit row when both filters match. Mint and
burn Transfer logs reconstruct supply. Per-bridge inflows/outflows can be
queried from the filtered Transfer rows.

```text
khalaBridge = khalaLegacyChainBridge + khalaChainBridge
vaultReward = vaultBalance - totalAssets - treasuryAssets - unstakeLocked
ethereumCirculation = totalSupply - reward - sunsetReward - phalaChainBridge
                      - khalaBridge - sygmaBridge - portalBridge - vaultReward
baseCirculation = totalSupply - reward - phalaChainBridge - khalaBridge
                  - sygmaBridge - portalBridge
```

A negative `vaultReward` is valid when promised rewards exceed funding.
Substrate's historical Phala/Khala circulation remains a frozen archive outside
these subgraphs; vPHA on Phala L2 remains outside this formula.

Every Vault event declares reads of the seven accrual getters. The verified
implementation uses **basis points**, not a WAD treasury ratio:

```text
rewards = paused || shareSupply == 0 ? 0 : rewardRate * (T - checkpointTime)
treasuryRewards = floor(rewards * treasuryRatio / 10000)
totalAssets(T) = checkpointTotalAssets + rewards - treasuryRewards
treasuryAssets(T) = checkpointTreasuryAssets + treasuryRewards
APR = rewardRate * (1 - treasuryRatio / 10000) * 31536000 / totalAssets
```

`Withdraw` increases locked PHA, `Claimed` decreases it, and `Deposit` decreases
it only when `sender == Vault`. `TreasurySettled` and `TreasuryAssetsClaimed`
are separate flows. Contract reads are end-of-block values; cumulative locked
assets and share holders follow log order.

`Upgraded` refreshes the declared calls and persists `vaultImplementation`,
`vaultImplementationReviewed`, and `accrualMode` in the public current/daily
entities (`VaultState` calls the address `implementation`). The reviewed
implementation is `0xC0b39989381D8C88b7ef82A80d4C90540E70862A`.

An unknown implementation keeps indexing token events, holders and claimers,
but sets `vaultImplementationReviewed: false` and `accrualMode: "checkpoint-only"`.
It uses checkpoint asset values without extrapolation; APR is zero. If a getter
has disappeared, the last complete checkpoint is retained. Both `ChainDay` and
`VaultDay` carry the flag so a cached daily row cannot silently look verified.
Before the Vault exists (and on Base), the flag is true, the implementation is
the zero address and mode is `inactive`.

**Consumer requirement for PR2:** pha-circulation-server must return 503 for
circulation when the flag is false, and its health workflow must alert on it.
Claim-page queries continue to work. The parity runner refuses promotion with
an unreviewed current implementation.

Upgrade runbook: review the new verified ABI and formula → update the ABI and
implementation allowlist (and formula dispatch if changed) → deploy a new
version → rerun feature/parity verification → move the `prod` tag after approval.
Do not re-enable extrapolation by merely changing a consumer flag.

## Development

Use Bun **1.4.2** and Node.js compatible with graph-cli 0.98.1 (20.18.1+).
Dependencies are exact pins; `bun.lock` is the text lockfile.

```bash
bun install --frozen-lockfile
bun run codegen          # both manifests; Ethereum first generates Vault bindings
bun run build            # build/ethereum/subgraph.yaml and build/base/subgraph.yaml
bun run test             # matchstick 0.6.0; Linux x64 Ubuntu 22/24, or supported macOS
bun run test:verify      # parity comparison fixtures, offline
bun run typecheck       # parity scripts (mappings compile during graph build)
bun run check           # Biome CI
```

Matchstick's Linux binary requires `libpq.so.5`; CI installs `libpq5` in its
Ubuntu 22.04 runner. On other hosts use Matchstick's supported Docker option
(`bunx --no-install graph test -d -v 0.6.0`). Biome formats AssemblyScript, but
its TypeScript lint/organize passes are disabled there because AssemblyScript
has its own builtins and import conventions. Scripts use recommended lint rules.

## Deploy and tag (root operator only)

These commands describe the later D1/D2 steps; they have **not** been run for
this PR. Confirm Goldsky authentication and the **Scale** plan before deploying.
Starter is a one-time credit and can pause the claim-page dependency.

1. D1: deploy a temporary short-range copy to test topic filters, declared calls,
   and Clock polling on Goldsky. Keep the test's source start blocks and the
   initial accumulator date consistent; it is a feature smoke test, not a
   historical parity candidate. Observe `_meta.hasIndexingErrors == false`,
   successful Vault checkpoints, and changing `Latest.timestamp` through a quiet
   polling interval. Delete the test version afterwards.
2. D2: deploy the full manifests, with no graft. Deploy the **compiled manifest
   directories**, so Goldsky can use its standard `subgraph.yaml` filename:

   ```bash
   bun run codegen
   bun run build
   goldsky subgraph deploy phala-ethereum/1.0.0 --path build/ethereum
   goldsky subgraph deploy phala-base/1.0.0 --path build/base
   ```

3. Wait for both deployments to sync and run the subgraph parity stage below.
   Keep the JSON report and snapshot cache as cutover evidence.
4. After the gates pass and the user approves the tag move:

   ```bash
   goldsky subgraph tag create phala-ethereum/1.0.0 --tag prod
   goldsky subgraph tag create phala-base/1.0.0 --tag prod
   ```

Endpoints are `https://api.goldsky.com/api/public/project_cmdgxxcewrqdi01wx9e7md0ek/subgraphs/<name>/prod/gn`.
For future versions, deploy alongside the current version, verify, then move
the tag. Keep the old versions for rollback until the agreed soak completes.
No Goldsky mutation runs from CI.

`indexerHints.prune: auto` retains immutable history while pruning old mutable
versions. Consumers query daily/event entities plus current `Latest`; the
verifier does not time-travel the new subgraphs. It filters immutable events to
a common block when comparing claimers and Vault audit records.

## Parity verification

The runner exits nonzero on any failed gate and writes a JSON report. Endpoint
URLs and archive paths come from arguments or environment variables; it does
not load secret files. A run covers all deployment dates through the available
ChainDays. The old snapshot scan is sequential and can take hours. Requests
are paced to at most four per second. `--snapshot-cache` stores public old API
responses as NDJSON and resumes completed reads on rerun; it never skips a gate.
Archive locations are recorded in [SPEC.md](./SPEC.md).

```bash
# GOLDSKY_ETHEREUM_URL and GOLDSKY_BASE_URL: synced version endpoints, before tagging.
# SNAPSHOTS_NDJSON and DUNE_RESULTS_JSON: the two local archive paths.
bun run verify --stage subgraphs --snapshot-cache /tmp/phala-parity/snapshots.ndjson \
  --output /tmp/phala-parity/subgraphs.json

# Later, after PR2's preview exists: API shape/types, current total, 30 snapshot dates.
bun run verify --stage server --preview "$SERVER_PREVIEW_URL" \
  --output /tmp/phala-parity/server.json

# Later, after PR4: normalized read-only D1 export and all 663 Cloud archive rows.
bun run verify --stage cache --d1-json "$D1_EXPORT_JSON" \
  --output /tmp/phala-parity/cache.json
```

Create the output directory first. `--stage all` requires all inputs and runs
all eight gates. `--ethereum`, `--base`, `--ndjson`, `--results`, `--old-api`,
`--old-vault`, `--old-khala`, `--old-phala` override the defaults/env inputs.
`SERVER_PREVIEW_URL` and `D1_EXPORT_JSON` also work without their flags. The old
API/subgraph defaults are the current public production endpoints.

The cache stage accepts a JSON object with `circulation_day`, `vault_day`,
`claim_day`, and `cloud_daily` arrays from a read-only SQL export. Preserve
`date` and `chain`; normalize metric keys to the corresponding Graph field
names and amounts to PHA decimal strings or numbers, counts to integers. Keep
Cloud columns `total_users`, `total_vms`, `running_vms`, `total_vcpu`, `captured`
verbatim. This adapter is independent of PR4's eventual SQL column casing.

Gate 1 compares every component the old API exposes: Ethereum's Khala balance
is the merged sum; Base only exposes supply and circulation. Missing raw
per-address inputs are listed in the report. First-block differences must equal
the signed sum of audited Transfers (locked assets use VaultEvent records),
and at most 1% of dates may need this exception. Gate 2 bounds vaultReward and
the **derived** assets+treasury sum by `rewardRate * delay + 1e-6 PHA`, after
first-block Vault flows. The raw sum is not independently available in the old
API. Archive circulation has relative tolerance `1e-7`; larger differences
require the passing old-snapshot explanation. Dune uses settlement values for
`flowDate`, relative tolerance `1e-12`, with exactly 550 dated asset rows. The
archive contains dailyRewards only on 2026-10-10; the other 549 dates are listed
as unavailable in the report, not interpreted as zero. As an additional internal
check, each settlement-day asset delta must equal the rewards plus net
deposit/withdraw flows between its and the previous settlement day's final
settlement events. The report includes per-day residuals; a nonzero residual
contradicts the verified contract's accounting and fails the gate. Checkpoints
match at every legacy event, and claimers match every ID and every field.

Optional independent raw balance/asset spot checks use `ARCHIVE_RPC_URL`
(Ethereum) and `BASE_ARCHIVE_RPC_URL`, or `--archive-rpc` /
`--base-archive-rpc`. These are **verification-only** archive RPC reads through
a dev dependency; mappings and consumers do not use RPC. Each configured chain
samples 30 dates (`--samples N`), deterministically including first/last dates
and prioritizing dates with first-block S transfers. Each compares all raw
balances and supply at the day's observed block; Ethereum also compares
`totalAssets` and `treasuryAssets` evaluated at that observed block's timestamp.
The initial pre-deployment midnight has zero state and no contract read.
Unconfigured RPC checks are explicitly reported as skipped.

The server stage allows only the approved source metadata replacement
(`headBlockNumber` / `lagBlocks` → `indexedAt` / `lagSeconds`); all other endpoint
key sets and value types must remain identical. Cache row counts and latest
amounts must match the subgraphs within `1e-9`, and archived Cloud values match
exactly including `captured`. An offline comparison test run does not establish
live parity; D1 feature validation and D2/full parity remain root-operated gates.
