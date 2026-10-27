# PR1 specification — approved indexer-first plan

This implements the root-approved PR1 from the 2026-10-27 analytics migration.
The GitHub repository stays `Phala-Network/phala-vault-state-subgraph` until a
separate approved rename. No production changes belong to this PR.

## Scope and sources

- `ethereum.yaml` and `base.yaml`; specVersion 1.2.0, `prune: auto`, no graft,
  no timeseries or aggregation features. Fixed Clock starts near the development
  head: Ethereum 26283000, every 25 blocks; Base 52000000, every 150 blocks.
- PHA deployment starts: Ethereum 9975568 (2020-04-30), Base 12743284
  (2024-04-05). Vault starts at 21596326. Khala claimer starts at its verified
  deployment block 21596400; Phala claimer conservatively starts there too.
- Exact excluded addresses and circulation math from
  [pha-circulation-server origin/main](https://github.com/Phala-Network/pha-circulation-server/tree/main/src)
  `chain.ts` / `calc.ts`; raw Khala bridge balances remain separate in entities.
- Vault ABI and formula from the
  [verified implementation](https://sourcify.dev/server/v2/contract/1/0xC0b39989381D8C88b7ef82A80d4C90540E70862A?fields=all),
  with proxy `Upgraded` added. Treasury denominator is 10000, with floor rounding.
- Exact claimer schema confirmed through public introspection of
  `khala-claimer/1.0.0` and `phala-claimer/1.0.0`, including nullability, and
  [apps khala-assets.ts](https://github.com/Phala-Network/apps/blob/main/apps/app/hooks/khala-assets.ts).
- Standard Graph features follow upstream
  [manifest](https://github.com/graphprotocol/docs/blob/main/website/src/pages/en/subgraphs/developing/creating/subgraph-manifest.mdx)
  and [advanced features](https://github.com/graphprotocol/docs/blob/main/website/src/pages/en/subgraphs/developing/creating/advanced.mdx)
  documentation: topic filters, declared eth_calls, polling block handlers.

## Root decisions resolving plan gaps

- `observedBlockNumber` / `observedBlockTimestamp` mean the last observed block
  before day closure. No every-block handler is added. Values are still evaluated
  exactly at midnight; initial deployment-day midnight is zero before deployment.
- `VaultEvent` is an immutable flow/audit log supporting exact old checkpoint
  comparisons without historical mutable-state queries. `VaultStateCheckpoint`
  and replay.ts are removed.
- `date` is the midnight boundary. `flowDate` is the preceding UTC day.
  `settlementTotalAssets` is nullable and reproduces Dune's last settlement;
  midnight `totalAssets` is a separate, accrued metric.
- Unknown upgrades keep the shared claimer subgraph indexing, but persist an
  unreviewed implementation flag with checkpoint-only accrual (including daily
  entities). Missing getters preserve the last complete checkpoint. PR2 and
  health checks must treat this flag as circulation 503/alert. Promotion requires
  source/ABI review, allowlist/formula update, redeploy, verification, then tag.
- Gate 1 compares every component exposed by the old snapshot API and reports
  omitted raw components. Optional archive-RPC sampling independently checks
  those components. The derived assets+treasury comparison depends on the old
  vaultReward and audited first-block PHA/Vault flows.

## Acceptance and staged parity gates

CI: frozen Bun install, codegen and build both manifests, matchstick tests,
offline parity tests, parity-script typecheck, Biome CI. Required mapping tests
cover gap-fill, zero/paused accrual, upgrades, S-to-S dedup, claimer compatibility,
Holder counts and locked-asset flows.

`bun run verify --stage subgraphs`:

1. Every date since 2020-04-30 vs old `/api/snapshot`, exact exposed components;
   differences only from signed first-block transfers, at most 1% of dates.
2. Vault accrual residual and derived totalAssets+treasury: absolute difference
   at most `midnight rewardRate * (old block timestamp - midnight) + 1e-6 PHA`.
3. Circulation vs 1,825 NDJSON rows and 365 Dune History rows: relative difference
   <=1e-7 or independently explained by passing gates 1–2.
4. Vault settlement assets vs all 550 dated Dune rows, relative difference
   <=1e-12, no extra settlement days through 2026-10-10. Compare every archived
   dailyRewards value (only 2026-10-10 is available, exactly 34930.0634765625 PHA);
   list 549 unavailable rewards dates, without treating them as zero or failure.
   Also report per-day settlement asset residuals against intervening RewardsSettled,
   Deposit and Withdraw audit logs; fail a definite accounting contradiction.
5. unstakeLocked equals every old checkpoint event exactly (a stronger audit
   than just the final checkpoint per block).
6. Claimer complete ID sets and every legacy field at the same common block;
   the old Phala claimer's `claimeds` must remain empty.

`--stage server` (after PR2) runs gate 7: matching endpoint keys/types except the
approved source metadata change, `/api/all` circulation within relative 1e-6,
and 30 deterministic snapshot dates equal ChainDay values.

`--stage cache` (after PR4) runs gate 8: normalized D1 export row counts match
ChainDay/VaultDay/ClaimDay, latest amounts agree within relative 1e-9, all 663
Cloud archive rows including captured match exactly. `--stage all` runs all.
Missing required stage inputs fail; optional archive-RPC samples report skipped
when unset. Archive sample count defaults to 30 per configured chain, including
first/last dates and preferring first-block S-transfer dates.

Archive input paths (local migration artifacts; never commit the data):

- NDJSON: `/home/kingsley/clawdi-meta/tasks/2026-10-27-dune-to-cloudflare/data/backup/dune-snapshots-20260923/dune-snapshots-backup-2026-09-23T19-38-44-719Z.ndjson`
- Dune: `/home/kingsley/clawdi-meta/tasks/2026-10-23-ovh-migration/dune-export/results.json`

Raw-executions confirms the historical chart only exported day and totalAssets;
549 dailyRewards values cannot be independently recovered from these artifacts.
Dune's undated summary rows are excluded from the 550 Vault / 663 Cloud dates.
Legacy Phala/Khala circulation comes from the frozen archive, not these EVM
subgraphs. Production data validation cannot be completed before a new deployment.

## Root-only remaining work

D1: approved temporary feature test deploy; prove polling, filters and declared
calls on Goldsky. D2: approved full historical deploy, sync, gates 1–6, tag move.
PR2/PR3/PR4 then migrate consumers and run gates 7–8. Keep old deployments for
rollback until the later approved seven-day soak and cleanup. See README for
commands and the single shared operations document.
