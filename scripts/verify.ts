import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, http, parseAbi } from "viem";
import {
  ADDRESSES,
  abs,
  close,
  compareCheckpoints,
  compareClaimers,
  compareSnapshot,
  compareVault,
  compareVaultConsistency,
  dated,
  deterministicSample,
  exportRows,
  finite,
  integer,
  pha,
  type Row,
  record,
  rows,
  shape,
  text,
  utcDate,
  wei as weiAmount,
} from "./verify-lib";

const COMPONENTS =
  "totalSupply reward sunsetReward phalaChainBridge khalaLegacyChainBridge khalaChainBridge sygmaBridge portalBridge vaultBalance vaultTotalAssets vaultTreasuryAssets vaultUnstakeLocked vaultReward circulation";
const DAY_FIELDS = `id chain date timestamp observedBlockNumber observedBlockTimestamp vaultImplementation vaultImplementationReviewed accrualMode ${COMPONENTS}`;
const VAULT_FIELDS =
  "id date flowDate timestamp observedBlockNumber observedBlockTimestamp totalAssets treasuryAssets shareSupply sharePrice apr stakers unstakeLocked rewardRate treasuryRatio paused vaultImplementation vaultImplementationReviewed accrualMode settlementTotalAssets dailyRewards dailyTreasuryRewards deposits withdrawRequests claims treasuryClaims depositCount withdrawRequestCount claimCount treasurySettlementCount";
const EVENT_FIELDS =
  "id kind assets shares settlementAssets blockNumber timestamp logIndex unstakeLockedAfter checkpointTime checkpointTotalAssets checkpointTreasuryAssets rewardRate treasuryRatio shareSupply paused vaultImplementationReviewed accrualMode";
const CLAIM_FIELDS =
  "id block_number timestamp_ transactionHash_ contractId_ user free staked";
const BASE_URL =
  "https://api.goldsky.com/api/public/project_cmdgxxcewrqdi01wx9e7md0ek/subgraphs";
const OLD_API = "https://pha-circulation-server.vercel.app";

let nextReadAt = 0;
async function json(url: string, body?: Row): Promise<unknown> {
  const wait = Math.max(0, nextReadAt - Date.now());
  if (wait) await Bun.sleep(wait);
  nextReadAt = Date.now() + 250;
  // Do not echo endpoint URLs: callers may supply signed/private endpoints.
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  assert.ok(response.ok, `Upstream HTTP ${response.status}`);
  return response.json();
}
async function gql(
  url: string,
  query: string,
  variables: Row = {},
): Promise<Row> {
  const response = record(await json(url, { query, variables }));
  assert.ok(!response.errors, "GraphQL returned errors");
  return record(response.data);
}
async function meta(url: string): Promise<Row> {
  const value = record(
    (
      await gql(
        url,
        "{_meta{deployment hasIndexingErrors block{number timestamp}}}",
      )
    )._meta,
  );
  assert.equal(value.hasIndexingErrors, false, "Subgraph has indexing errors");
  assert.ok(Number.isSafeInteger(record(value.block).number));
  assert.ok(
    Number.isSafeInteger(record(value.block).timestamp),
    "Missing indexed block timestamp",
  );
  return value;
}
async function page(
  url: string,
  entity: string,
  fields: string,
  options: {
    bytes?: boolean;
    filter?: string;
    variables?: Row;
    declarations?: string;
  } = {},
): Promise<Row[]> {
  const result: Row[] = [];
  let after = options.bytes ? "0x" : "";
  while (true) {
    const query = `query($after:${options.bytes ? "Bytes" : "ID"}!${options.declarations ?? ""}){${entity}(first:1000,orderBy:id,orderDirection:asc,where:{id_gt:$after${options.filter ? `,${options.filter}` : ""}}){${fields}}}`;
    const batch = rows(
      (
        await gql(url, query, {
          after,
          ...options.variables,
        })
      )[entity],
    );
    if (batch.length === 0) return result;
    for (const row of batch) {
      assert.ok(text(row.id) > after, "Unordered or repeated pagination ID");
      after = text(row.id);
      result.push(row);
    }
    if (batch.length < 1000) return result;
  }
}
const required = (value: string | undefined, label: string): string => {
  assert.ok(value, `Missing ${label}`);
  return value;
};
function args() {
  const { values } = parseArgs({
    options: {
      stage: { type: "string", default: "subgraphs" },
      ethereum: { type: "string" },
      base: { type: "string" },
      "old-api": { type: "string", default: OLD_API },
      "old-vault": {
        type: "string",
        default: `${BASE_URL}/phala-vault-state/prod/gn`,
      },
      "old-khala": {
        type: "string",
        default: `${BASE_URL}/khala-claimer/1.0.0/gn`,
      },
      "old-phala": {
        type: "string",
        default: `${BASE_URL}/phala-claimer/1.0.0/gn`,
      },
      ndjson: { type: "string" },
      results: { type: "string" },
      preview: { type: "string" },
      "d1-json": { type: "string" },
      output: { type: "string", default: "verification-results.json" },
      "snapshot-cache": { type: "string" },
      "archive-rpc": { type: "string" },
      "base-archive-rpc": { type: "string" },
      samples: { type: "string", default: "30" },
    },
  });
  assert.ok(["subgraphs", "server", "cache", "all"].includes(values.stage));
  return {
    ...values,
    ethereum: required(
      values.ethereum ?? process.env.GOLDSKY_ETHEREUM_URL,
      "--ethereum / GOLDSKY_ETHEREUM_URL",
    ),
    base: required(
      values.base ?? process.env.GOLDSKY_BASE_URL,
      "--base / GOLDSKY_BASE_URL",
    ),
    ndjson: values.ndjson ?? process.env.SNAPSHOTS_NDJSON,
    results: values.results ?? process.env.DUNE_RESULTS_JSON,
    preview: values.preview ?? process.env.SERVER_PREVIEW_URL,
    "d1-json": values["d1-json"] ?? process.env.D1_EXPORT_JSON,
    "archive-rpc": values["archive-rpc"] ?? process.env.ARCHIVE_RPC_URL,
    "base-archive-rpc":
      values["base-archive-rpc"] ?? process.env.BASE_ARCHIVE_RPC_URL,
  };
}
type Options = ReturnType<typeof args>;
interface Evidence {
  ethereum: Row[];
  base: Row[];
  vault: Row[];
  events: Row[];
  ethMeta: Row;
  baseMeta: Row;
  oldSnapshots: Map<string, Row>;
  transferDates: Set<string>;
}
async function load(options: Options): Promise<Evidence> {
  const ethMeta = await meta(options.ethereum);
  const baseMeta = await meta(options.base);
  const currentVault = record(
    (
      await gql(
        options.ethereum,
        '{latest(id:"current"){vaultImplementationReviewed accrualMode}}',
      )
    ).latest,
  );
  assert.equal(
    currentVault.vaultImplementationReviewed,
    true,
    "Unreviewed Vault implementation; review before promotion",
  );
  const latestBase = record(
    (await gql(options.base, '{latest(id:"current"){timestamp}}')).latest,
  );
  const latestEth = record(
    (await gql(options.ethereum, '{latest(id:"current"){timestamp}}')).latest,
  );
  for (const latest of [latestEth, latestBase])
    assert.ok(
      Math.abs(Date.now() / 1000 - Number(integer(latest.timestamp))) <= 900,
      "Latest is more than 15 minutes old; wait for full sync and Clock polling",
    );
  const cutoffOptions = (metaValue: Row) => ({
    filter: "timestamp_lte:$cutoff",
    declarations: ",$cutoff:BigInt!",
    variables: { cutoff: String(record(metaValue.block).timestamp) },
  });
  const ethereum = await page(
    options.ethereum,
    "chainDays",
    DAY_FIELDS,
    cutoffOptions(ethMeta),
  );
  const base = await page(
    options.base,
    "chainDays",
    DAY_FIELDS,
    cutoffOptions(baseMeta),
  );
  assert.ok(
    ethereum.every((day) => day.vaultImplementationReviewed === true),
    "Unreviewed historical Vault day; reindex after implementation review",
  );
  assert.ok(
    ethereum.length > 0 && base.length > 0,
    "New subgraphs have no daily entities",
  );
  return {
    ethereum,
    base,
    vault: await page(
      options.ethereum,
      "vaultDays",
      VAULT_FIELDS,
      cutoffOptions(ethMeta),
    ),
    events: await page(options.ethereum, "vaultEvents", EVENT_FIELDS, {
      bytes: true,
      filter: "blockNumber_lte:$cutoff",
      declarations: ",$cutoff:BigInt!",
      variables: { cutoff: String(record(ethMeta.block).number) },
    }),
    ethMeta,
    baseMeta,
    oldSnapshots: new Map(),
    transferDates: new Set(),
  };
}
async function cachedSnapshots(
  path: string | undefined,
): Promise<Map<string, Row>> {
  if (!path) return new Map();
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (record(error).code === "ENOENT") return new Map();
    throw error;
  }
  return new Map(
    content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value = record(JSON.parse(line));
        return [utcDate(value.date), value];
      }),
  );
}
async function atBlock(
  url: string,
  entity: "transfers" | "vaultEvents",
  block: string,
): Promise<Row[]> {
  return page(
    url,
    entity,
    entity === "transfers"
      ? "id from to amount blockNumber timestamp"
      : EVENT_FIELDS,
    {
      bytes: true,
      filter: "blockNumber:$blockNumber",
      declarations: ",$blockNumber:BigInt!",
      variables: { blockNumber: block },
    },
  );
}
async function balances(options: Options, evidence: Evidence): Promise<Row> {
  const cache = await cachedSnapshots(options["snapshot-cache"]);
  const base = dated(evidence.base);
  const vault = dated(evidence.vault);
  const ethereum = dated(evidence.ethereum);
  const dates = [...ethereum.keys()].sort();
  for (const map of [ethereum, base]) {
    const sorted = [...map.keys()].sort();
    const first = sorted[0];
    const last = sorted.at(-1);
    assert.ok(first && last);
    assert.equal(
      sorted.length,
      (Date.parse(last) - Date.parse(first)) / 86400000 + 1,
      "Missing daily snapshots within deployment range",
    );
  }
  assert.equal(
    dates[0],
    "2020-04-30",
    "Ethereum must start on deployment date",
  );
  assert.equal([...base.keys()].sort()[0], "2024-04-05");
  let explainedDates = 0;
  let maxAccrualDelta = 0n;
  let checked = 0;
  for (const date of dates) {
    const snapshot =
      cache.get(date) ??
      record(await json(`${options["old-api"]}/api/snapshot?date=${date}`));
    assert.equal(utcDate(snapshot.date), date, "Old snapshot date differs");
    evidence.oldSnapshots.set(date, snapshot);
    if (!cache.has(date) && options["snapshot-cache"])
      await appendFile(
        options["snapshot-cache"],
        `${JSON.stringify(snapshot)}\n`,
      );
    let explained = false;
    for (const [chain, day] of [
      ["ethereum", ethereum.get(date)],
      ["base", base.get(date)],
    ] as const) {
      if (chain === "base" && date < "2024-04-05") {
        assert.equal(snapshot.base, null);
        continue;
      }
      assert.ok(day, `Missing ${chain} day ${date}`);
      const old = record(snapshot[chain]);
      const url = chain === "ethereum" ? options.ethereum : options.base;
      const transfers = await atBlock(url, "transfers", text(old.blockNumber));
      const events =
        chain === "ethereum"
          ? evidence.events.filter(
              (event) => event.blockNumber === old.blockNumber,
            )
          : [];
      const result = compareSnapshot(
        day,
        old,
        transfers,
        events,
        vault.get(date),
      );
      explained ||= result.transferExplained;
      if (abs(result.accrualDelta) > maxAccrualDelta)
        maxAccrualDelta = abs(result.accrualDelta);
      if (transfers.length) evidence.transferDates.add(date);
    }
    if (explained) explainedDates++;
    checked++;
    if (checked % 100 === 0)
      console.log(`Snapshot comparisons: ${checked}/${dates.length}`);
  }
  assert.ok(
    explainedDates / dates.length <= 0.01,
    "More than 1% of dates need first-block flow explanations",
  );
  return {
    dates: dates.length,
    explainedDates,
    maxAccrualDeltaWei: maxAccrualDelta.toString(),
    coverage:
      "Every exposed old snapshot component; Ethereum Khala bridges compared as their merged sum. Base exposes only totalSupply and circulation. Separate Base balances, Ethereum vaultBalance and raw vault+treasury are covered only by optional archive-RPC samples. Vault+treasury gate 2 is derived from vaultReward and audited PHA/locked-asset flows.",
  };
}
function archives(evidence: Evidence, ndjson: string, exported: unknown): Row {
  const snapshots = ndjson
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
  assert.equal(snapshots.length, 1825, "Expected 1,825 ndjson snapshots");
  const history = exportRows(exported, "3572546", "updated_time");
  assert.equal(history.length, 365, "Expected 365 History rows");
  const ethereum = dated(evidence.ethereum);
  const base = dated(evidence.base);
  let explained = 0;
  for (const row of [...snapshots, ...history]) {
    const date = utcDate(row.updated_time);
    const day = ethereum.get(date);
    assert.ok(day, `Archive date missing ${date}`);
    const legacy =
      (row.phala_circulation == null ? 0 : finite(row.phala_circulation)) +
      (row.khala_circulation == null ? 0 : finite(row.khala_circulation));
    const baseDay = base.get(date);
    const actual =
      pha(day.circulation) + (baseDay ? pha(baseDay.circulation) : 0) + legacy;
    const expected =
      row.total_circulation == null
        ? finite(row.ethereum_circulation) +
          (row.base_circulation == null ? 0 : finite(row.base_circulation)) +
          legacy
        : finite(row.total_circulation);
    if (Math.abs(actual - expected) > Math.max(1, Math.abs(expected)) * 1e-7) {
      const old = evidence.oldSnapshots.get(date);
      assert.ok(old, `No gate 1/2 evidence for archive mismatch ${date}`);
      close(
        finite(old.totalCirculation) + legacy,
        expected,
        1e-7,
        `Archive differs from independent old snapshot ${date}`,
      );
      // balances() already proved each difference from this old snapshot is
      // exactly an audited first-block flow or within the accrued reward bound.
      explained++;
    }
  }
  return {
    ndjson: snapshots.length,
    history: history.length,
    beyondToleranceExplained: explained,
  };
}
async function claimers(options: Options, evidence: Evidence): Promise<Row> {
  const khalaMeta = await meta(options["old-khala"]);
  const phalaMeta = await meta(options["old-phala"]);
  const block = Math.min(
    Number(record(evidence.ethMeta.block).number),
    Number(record(khalaMeta.block).number),
    Number(record(phalaMeta.block).number),
  );
  const counts: Row = { block };
  for (const [entity, fields, oldUrl] of [
    ["claimeds", `${CLAIM_FIELDS} receiver`, options["old-khala"]],
    [
      "claimedAndBridgeds",
      `${CLAIM_FIELDS} l1Receiver l2Receiver`,
      options["old-phala"],
    ],
  ]) {
    assert.ok(entity && fields && oldUrl);
    const actual = await page(options.ethereum, entity, fields, {
      filter: "block_number_lte:$cutoff",
      declarations: ",$cutoff:BigInt!",
      variables: { cutoff: String(block) },
    });
    const expected = await page(oldUrl, entity, fields, {
      filter: "block_number_lte:$cutoff",
      declarations: ",$cutoff:BigInt!",
      variables: { cutoff: String(block) },
    });
    compareClaimers(actual, expected);
    counts[entity] = actual.length;
  }
  const unexpected = await gql(
    options["old-phala"],
    "query($cutoff:BigInt!){claimeds(first:1,where:{block_number_lte:$cutoff}){id}}",
    { cutoff: String(block) },
  );
  assert.equal(
    rows(unexpected.claimeds).length,
    0,
    "Phala-only Claimed entity is no longer empty: spec needs review",
  );
  return counts;
}
const rpcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function treasuryAssets() view returns (uint256)",
]);
function address(value: string | undefined): `0x${string}` {
  assert.ok(value && /^0x[a-fA-F0-9]{40}$/.test(value), "Invalid address");
  return value as `0x${string}`;
}
function accrued(
  event: Row,
  timestamp: bigint,
): { total: bigint; treasury: bigint } {
  let rewards = 0n;
  if (
    event.vaultImplementationReviewed &&
    !event.paused &&
    integer(event.shareSupply) > 0n
  ) {
    assert.ok(timestamp >= integer(event.checkpointTime));
    rewards =
      integer(event.rewardRate) * (timestamp - integer(event.checkpointTime));
  }
  const treasury = (rewards * integer(event.treasuryRatio)) / 10000n;
  return {
    total: integer(event.checkpointTotalAssets) + rewards - treasury,
    treasury: integer(event.checkpointTreasuryAssets) + treasury,
  };
}
async function archiveRpc(
  options: Options,
  evidence: Evidence,
): Promise<Row[]> {
  const result: Row[] = [];
  for (const chain of ["ethereum", "base"] as const) {
    const rpc =
      chain === "ethereum"
        ? options["archive-rpc"]
        : options["base-archive-rpc"];
    if (!rpc) {
      result.push({
        chain,
        status: "skipped",
        reason: `No ${chain === "ethereum" ? "ARCHIVE_RPC_URL" : "BASE_ARCHIVE_RPC_URL"}`,
      });
      continue;
    }
    const client = createPublicClient({
      transport: http(rpc, { timeout: 90_000, retryCount: 0 }),
    });
    const days = chain === "ethereum" ? evidence.ethereum : evidence.base;
    const byDate = dated(days);
    const dates = deterministicSample(
      [...byDate.keys()].sort(),
      Number(options.samples),
      evidence.transferDates,
    );
    for (const date of dates) {
      const day = byDate.get(date);
      assert.ok(day);
      const blockNumber = integer(day.observedBlockNumber);
      if (blockNumber === 0n) {
        // No contract existed at the initial midnight; total supply is zero.
        assert.equal(integer(day.totalSupply), 0n);
        continue;
      }
      const token = address(
        chain === "ethereum"
          ? "0x6c5ba91642f10282b576d91922ae6448c9d52f4e"
          : "0x336c9297afb7798c292e9f80d8e566b947f291f0",
      );
      const supply = await client.readContract({
        address: token,
        abi: rpcAbi,
        functionName: "totalSupply",
        blockNumber,
      });
      assert.equal(
        supply,
        integer(day.totalSupply),
        `${chain} ${date}: raw total supply differs`,
      );
      for (const [component, holder] of Object.entries(ADDRESSES)) {
        if (
          chain === "base" &&
          ["sunsetReward", "vaultBalance"].includes(component)
        )
          continue;
        const amount = await client.readContract({
          address: token,
          abi: rpcAbi,
          functionName: "balanceOf",
          args: [address(holder)],
          blockNumber,
        });
        assert.equal(
          amount,
          integer(day[component]),
          `${chain} ${date}: raw ${component} differs`,
        );
      }
      if (chain === "ethereum" && blockNumber >= 21596326n) {
        const event = evidence.events
          .filter((item) => integer(item.blockNumber) <= blockNumber)
          .sort(
            (a, b) =>
              Number(integer(a.blockNumber) - integer(b.blockNumber)) ||
              Number(integer(a.logIndex) - integer(b.logIndex)),
          )
          .at(-1);
        assert.ok(event, "Missing vault checkpoint for raw RPC comparison");
        const expected = accrued(event, integer(day.observedBlockTimestamp));
        assert.equal(
          await client.readContract({
            address: address(ADDRESSES.vaultBalance),
            abi: rpcAbi,
            functionName: "totalAssets",
            blockNumber,
          }),
          expected.total,
          `${date}: raw totalAssets differs`,
        );
        assert.equal(
          await client.readContract({
            address: address(ADDRESSES.vaultBalance),
            abi: rpcAbi,
            functionName: "treasuryAssets",
            blockNumber,
          }),
          expected.treasury,
          `${date}: raw treasuryAssets differs`,
        );
      }
    }
    result.push({ chain, status: "pass", samples: dates.length });
  }
  return result;
}
async function server(options: Options, evidence: Evidence): Promise<Row> {
  const preview = required(options.preview, "--preview / SERVER_PREVIEW_URL");
  for (const endpoint of ["circulation", "all"]) {
    const expected = await json(`${options["old-api"]}/api/${endpoint}`);
    const actual = await json(`${preview}/api/${endpoint}`);
    if (endpoint === "all") {
      // The plan explicitly replaces these source metadata fields in PR2.
      const oldSource = record(record(record(expected).sources).ethereum);
      const newSource = record(record(record(actual).sources).ethereum);
      delete oldSource.headBlockNumber;
      delete oldSource.lagBlocks;
      assert.equal(typeof newSource.indexedAt, "string");
      assert.equal(typeof newSource.lagSeconds, "string");
      delete newSource.indexedAt;
      delete newSource.lagSeconds;
      close(
        finite(record(actual).totalCirculation),
        finite(record(expected).totalCirculation),
        1e-6,
        "/all circulation differs",
      );
    }
    assert.deepEqual(
      shape(actual),
      shape(expected),
      `${endpoint}: key sets or types differ`,
    );
  }
  const ethereum = dated(evidence.ethereum);
  const base = dated(evidence.base);
  const dates = deterministicSample([...ethereum.keys()].sort(), 30);
  for (const date of dates) {
    const actual = record(await json(`${preview}/api/snapshot?date=${date}`));
    const expected = await json(
      `${options["old-api"]}/api/snapshot?date=${date}`,
    );
    assert.deepEqual(
      shape(actual),
      shape(expected),
      `${date}: snapshot key sets or types differ`,
    );
    for (const [chain, day] of [
      ["ethereum", ethereum.get(date)],
      ["base", base.get(date)],
    ] as const) {
      if (!day) {
        assert.equal(actual[chain], null);
        continue;
      }
      const snapshot = record(actual[chain]);
      for (const field of ["circulation", "totalSupply"])
        assert.equal(
          weiAmount(snapshot[field]),
          integer(day[field]),
          `${chain} ${date}: snapshot ${field} differs`,
        );
      if (chain === "ethereum") {
        for (const field of [
          "reward",
          "sunsetReward",
          "phalaChainBridge",
          "sygmaBridge",
          "portalBridge",
          "vaultReward",
          "vaultUnstakeLocked",
        ])
          assert.equal(
            weiAmount(snapshot[field]),
            integer(day[field]),
            `${date}: snapshot ${field} differs`,
          );
        assert.equal(
          weiAmount(snapshot.khalaChainBridge),
          integer(day.khalaChainBridge) + integer(day.khalaLegacyChainBridge),
        );
      }
    }
  }
  return {
    snapshots: dates.length,
    sourceMetadataChange:
      "headBlockNumber/lagBlocks replaced by indexedAt/lagSeconds as approved",
  };
}

// Kept local to make the API's PHA-string to integer-wei conversion explicit.

function cacheCheck(
  value: unknown,
  exported: unknown,
  evidence: Evidence,
): Row {
  const data = record(value);
  const circulation = rows(data.circulation_day);
  assert.equal(
    circulation.length,
    evidence.ethereum.length + evidence.base.length,
    "D1 circulation row count differs",
  );
  const vault = rows(data.vault_day);
  const claims = rows(data.claim_day);
  assert.equal(
    vault.length,
    evidence.vault.length,
    "D1 vault row count differs",
  );
  // Raw SQL export values are PHA decimals; IDs/date/chain remain strings.
  for (const chain of ["ethereum", "base"] as const) {
    const expected = chain === "ethereum" ? evidence.ethereum : evidence.base;
    const actual = dated(circulation.filter((row) => row.chain === chain));
    assert.equal(actual.size, expected.length);
    const last = [...expected]
      .sort((a, b) => text(a.date).localeCompare(text(b.date)))
      .at(-1);
    assert.ok(last);
    const row = actual.get(utcDate(last.date));
    assert.ok(row);
    for (const field of COMPONENTS.split(" "))
      close(
        finite(row[field]),
        pha(last[field]),
        1e-9,
        `D1 latest ${chain}.${field} differs`,
      );
  }
  const latestVault = [...evidence.vault]
    .sort((a, b) => text(a.date).localeCompare(text(b.date)))
    .at(-1);
  if (latestVault) {
    const row = dated(vault).get(utcDate(latestVault.date));
    assert.ok(row);
    for (const field of [
      "totalAssets",
      "treasuryAssets",
      "shareSupply",
      "unstakeLocked",
      "dailyRewards",
      "dailyTreasuryRewards",
      "deposits",
      "withdrawRequests",
      "claims",
      "treasuryClaims",
    ])
      close(
        finite(row[field]),
        pha(latestVault[field]),
        1e-9,
        `D1 latest Vault.${field} differs`,
      );
  }
  const cloud = dated(rows(data.cloud_daily));
  const expectedCloud = exportRows(exported, "4614059", "date");
  assert.equal(expectedCloud.length, 663, "Expected all 663 dated Cloud rows");
  for (const row of expectedCloud) {
    const actual = cloud.get(utcDate(row.date));
    assert.ok(actual, `D1 Cloud date missing ${row.date}`);
    for (const field of [
      "total_users",
      "total_vms",
      "running_vms",
      "total_vcpu",
      "captured",
    ])
      assert.equal(
        actual[field],
        row[field] ?? null,
        `Cloud ${row.date}.${field} differs`,
      );
  }
  assert.equal(
    [...cloud.keys()].filter((date) => date <= "2026-09-22").length,
    663,
    "Extra Cloud archive dates",
  );
  return {
    circulation: circulation.length,
    vault: vault.length,
    claims: claims.length,
    cloudArchive: expectedCloud.length,
  };
}

export async function main(): Promise<void> {
  const options = args();
  const report: Row = {
    startedAt: new Date().toISOString(),
    stage: options.stage,
    gates: {},
  };
  const gates = record(report.gates);
  try {
    const evidence = await load(options);
    report.deployments = {
      ethereum: evidence.ethMeta.deployment,
      base: evidence.baseMeta.deployment,
    };
    if (["subgraphs", "all"].includes(options.stage)) {
      gates["1-2"] = await balances(options, evidence);
      const exported: unknown = JSON.parse(
        await readFile(
          required(options.results, "--results / DUNE_RESULTS_JSON"),
          "utf8",
        ),
      );
      gates["3"] = archives(
        evidence,
        await readFile(
          required(options.ndjson, "--ndjson / SNAPSHOTS_NDJSON"),
          "utf8",
        ),
        exported,
      );
      gates["4"] = {
        ...compareVault(evidence.vault, exportRows(exported, "5154700", "day")),
        consistency: compareVaultConsistency(evidence.vault, evidence.events),
      };
      const oldMeta = await meta(options["old-vault"]);
      const cutoff = Math.min(
        Number(record(oldMeta.block).number),
        Number(record(evidence.ethMeta.block).number),
      );
      const checkpoints = await page(
        options["old-vault"],
        "vaultStateCheckpoints",
        "id blockNumber vaultUnstakeLocked",
        {
          bytes: true,
          filter: "blockNumber_lte:$cutoff",
          declarations: ",$cutoff:BigInt!",
          variables: { cutoff: String(cutoff) },
        },
      );
      compareCheckpoints(evidence.events, checkpoints);
      gates["5"] = { checkpoints: checkpoints.length, cutoff };
      gates["6"] = await claimers(options, evidence);
      report.archiveRpc = await archiveRpc(options, evidence);
    }
    if (["server", "all"].includes(options.stage))
      gates["7"] = await server(options, evidence);
    if (["cache", "all"].includes(options.stage)) {
      const exported: unknown = JSON.parse(
        await readFile(
          required(options.results, "--results / DUNE_RESULTS_JSON"),
          "utf8",
        ),
      );
      const data: unknown = JSON.parse(
        await readFile(
          required(options["d1-json"], "--d1-json / D1_EXPORT_JSON"),
          "utf8",
        ),
      );
      const cache = cacheCheck(data, exported, evidence);
      const expectedClaims = await page(
        options.ethereum,
        "claimDays",
        "id date khalaClaimCount khalaFree khalaStaked phalaClaimCount phalaFree phalaStaked",
      );
      const actualClaims = rows(record(data).claim_day);
      assert.equal(
        actualClaims.length,
        expectedClaims.length,
        "D1 ClaimDay row count differs",
      );
      const latest = [...expectedClaims]
        .sort((a, b) => text(a.date).localeCompare(text(b.date)))
        .at(-1);
      if (latest) {
        const actual = dated(actualClaims).get(utcDate(latest.date));
        assert.ok(actual);
        for (const field of [
          "khalaFree",
          "khalaStaked",
          "phalaFree",
          "phalaStaked",
        ])
          close(
            finite(actual[field]),
            pha(latest[field]),
            1e-9,
            `D1 ClaimDay ${field} differs`,
          );
        for (const field of ["khalaClaimCount", "phalaClaimCount"])
          assert.equal(finite(actual[field]), finite(latest[field]));
      }
      gates["8"] = cache;
    }
    report.status = "pass";
    console.log(`Parity gates passed for stage ${options.stage}`);
  } catch (error) {
    report.status = "fail";
    report.error =
      error instanceof assert.AssertionError
        ? error.message
        : "I/O or upstream read failed (endpoint details omitted)";
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
}
if (import.meta.main)
  main().catch(() => {
    // I/O errors can contain private endpoint URLs; never print their details.
    console.error("Parity verification failed; see the output report.");
    process.exitCode = 1;
  });
