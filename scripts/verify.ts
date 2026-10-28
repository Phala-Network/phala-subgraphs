import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, http, parseAbi } from "viem";
import {
  ADDRESSES,
  abs,
  CLAIM_FIELDS,
  claimerExport,
  close,
  compareArchive,
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
  type SnapshotComparison,
  START_DATE,
  shape,
  snapshotDates,
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
export function args(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      stage: { type: "string", default: "subgraphs" },
      "prefetch-snapshots": { type: "boolean", default: false },
      ethereum: { type: "string" },
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
      "old-khala-export": { type: "string" },
      "old-phala-export": { type: "string" },
      ndjson: { type: "string" },
      results: { type: "string" },
      preview: { type: "string" },
      "d1-json": { type: "string" },
      output: { type: "string", default: "verification-results.json" },
      "snapshot-cache": { type: "string" },
      "archive-rpc": { type: "string" },
      samples: { type: "string", default: "30" },
    },
  });
  assert.ok(["subgraphs", "server", "cache", "all"].includes(values.stage));
  const options = {
    ...values,
    ethereum: values.ethereum ?? process.env.GOLDSKY_ETHEREUM_URL,
    ndjson: values.ndjson ?? process.env.SNAPSHOTS_NDJSON,
    results: values.results ?? process.env.DUNE_RESULTS_JSON,
    preview: values.preview ?? process.env.SERVER_PREVIEW_URL,
    "d1-json": values["d1-json"] ?? process.env.D1_EXPORT_JSON,
    "archive-rpc": values["archive-rpc"] ?? process.env.ARCHIVE_RPC_URL,
  };
  if (options["prefetch-snapshots"])
    required(options["snapshot-cache"], "--snapshot-cache for prefetching");
  else endpoint(options);
  return options;
}
type Options = ReturnType<typeof args>;
function endpoint(options: Options): string {
  return required(options.ethereum, "--ethereum / GOLDSKY_ETHEREUM_URL");
}
interface Evidence {
  ethereum: Row[];
  vault: Row[];
  events: Row[];
  meta: { ethereum?: Row };
  comparisons: Map<string, SnapshotComparison>;
  oldSnapshots: Map<string, Row>;
  transferDates: Set<string>;
}
export async function load(options: Options): Promise<Evidence> {
  const evidence: Evidence = {
    ethereum: [],
    vault: [],
    events: [],
    meta: {},
    comparisons: new Map(),
    oldSnapshots: new Map(),
    transferDates: new Set(),
  };
  const cutoffOptions = (metaValue: Row) => ({
    filter: "timestamp_lte:$cutoff",
    declarations: ",$cutoff:BigInt!",
    variables: { cutoff: String(record(metaValue.block).timestamp) },
  });
  const url = endpoint(options);
  const indexed = await meta(url);
  evidence.meta.ethereum = indexed;
  const latest = record(
    (
      await gql(
        url,
        '{latest(id:"current"){timestamp vaultImplementationReviewed accrualMode}}',
      )
    ).latest,
  );
  assert.ok(
    Math.abs(Date.now() / 1000 - Number(integer(latest.timestamp))) <= 900,
    "Latest is more than 15 minutes old; wait for full sync and Clock polling",
  );
  assert.equal(
    latest.vaultImplementationReviewed,
    true,
    "Unreviewed Vault implementation; review before promotion",
  );
  evidence.ethereum = await page(
    url,
    "chainDays",
    DAY_FIELDS,
    cutoffOptions(indexed),
  );
  assert.ok(
    evidence.ethereum.length > 0,
    "New Ethereum subgraph has no daily entities",
  );
  evidence.vault = await page(
    url,
    "vaultDays",
    VAULT_FIELDS,
    cutoffOptions(indexed),
  );
  evidence.events = await page(url, "vaultEvents", EVENT_FIELDS, {
    bytes: true,
    filter: "blockNumber_lte:$cutoff",
    declarations: ",$cutoff:BigInt!",
    variables: { cutoff: String(record(indexed.block).number) },
  });
  assert.ok(
    evidence.ethereum.every((day) => day.vaultImplementationReviewed === true),
    "Unreviewed historical Vault day; reindex after implementation review",
  );
  return evidence;
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
async function snapshot(
  options: Options,
  cache: Map<string, Row>,
  date: string,
): Promise<Row> {
  const existing = cache.get(date);
  if (existing) return existing;
  const value = record(
    await json(`${options["old-api"]}/api/snapshot?date=${date}`),
  );
  assert.equal(utcDate(value.date), date, "Old snapshot date differs");
  if (options["snapshot-cache"])
    await appendFile(options["snapshot-cache"], `${JSON.stringify(value)}\n`);
  cache.set(date, value);
  return value;
}
async function prefetch(options: Options): Promise<Row> {
  const cache = await cachedSnapshots(options["snapshot-cache"]);
  const dates = snapshotDates();
  let fetched = 0;
  for (const date of dates) {
    if (!cache.has(date)) {
      await snapshot(options, cache, date);
      fetched++;
      if (fetched % 100 === 0) console.log(`Snapshots fetched: ${fetched}`);
    }
  }
  return {
    firstDate: dates[0],
    lastDate: dates.at(-1),
    dates: dates.length,
    fetched,
    cached: dates.length - fetched,
  };
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
  evidence.oldSnapshots = await cachedSnapshots(options["snapshot-cache"]);
  const days = dated(evidence.ethereum);
  const vault = dated(evidence.vault);
  const dates = [...days.keys()].sort();
  const first = dates[0];
  const last = dates.at(-1);
  assert.ok(first && last);
  assert.equal(
    dates.length,
    (Date.parse(last) - Date.parse(first)) / 86400000 + 1,
    "Missing daily snapshots within deployment range",
  );
  assert.equal(first, START_DATE, "Ethereum must start on deployment date");
  let explainedDates = 0;
  let maxAccrualDelta = 0n;
  let checked = 0;
  for (const date of dates) {
    const oldSnapshot = await snapshot(options, evidence.oldSnapshots, date);
    const day = days.get(date);
    assert.ok(day, `Missing Ethereum day ${date}`);
    const old = record(oldSnapshot.ethereum);
    const transfers = await atBlock(
      endpoint(options),
      "transfers",
      text(old.blockNumber),
    );
    const events = evidence.events.filter(
      (event) => event.blockNumber === old.blockNumber,
    );
    const result = compareSnapshot(
      day,
      old,
      transfers,
      events,
      vault.get(date),
    );
    evidence.comparisons.set(date, result);
    if (result.transferExplained) explainedDates++;
    if (abs(result.accrualDelta) > maxAccrualDelta)
      maxAccrualDelta = abs(result.accrualDelta);
    if (transfers.length) evidence.transferDates.add(date);
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
    coverage: {
      ethereum:
        "Every exposed old Ethereum component; circulation equals old circulation + old portalBridge, with audited first-block flows and bounded accrual. Khala bridges compared as their merged sum. vaultBalance and raw vault+treasury require optional archive-RPC samples. Gate 2 derives vault+treasury from vaultReward and audited PHA/locked-asset flows.",
    },
  };
}
async function archives(
  options: Options,
  evidence: Evidence,
  ndjson: string,
  exported: unknown,
): Promise<Row> {
  const snapshots = ndjson
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
  assert.equal(snapshots.length, 1825, "Expected 1,825 ndjson snapshots");
  const history = exportRows(exported, "3572546", "updated_time");
  assert.equal(history.length, 365, "Expected 365 History rows");
  const ethereum = dated(evidence.ethereum);
  const differences: Row[] = [];
  for (const row of [...snapshots, ...history]) {
    const date = utcDate(row.updated_time);
    const day = ethereum.get(date);
    assert.ok(day, `Archive Ethereum date missing ${date}`);
    const old = await snapshot(options, evidence.oldSnapshots, date);
    const comparison = evidence.comparisons.get(date);
    assert.ok(comparison, `No gate 1/2 evidence for archive ${date}`);
    differences.push(compareArchive(row, day, old, comparison));
  }
  return {
    ndjson: snapshots.length,
    history: history.length,
    totalSource:
      "New Ethereum ChainDay; archived Base replaced by old Ethereum Portal escrow",
    substrateSource: "Frozen Phala/Khala archive",
    differences,
  };
}

export async function claimers(
  options: Options,
  evidence: Evidence,
): Promise<Row> {
  const newBlock = Number(record(record(evidence.meta.ethereum).block).number);
  const counts: Row = {};
  for (const chain of ["khala", "phala"] as const) {
    const path = options[`old-${chain}-export`];
    const exported = path
      ? claimerExport(JSON.parse(await readFile(path, "utf8")), chain)
      : undefined;
    const oldUrl = options[`old-${chain}`];
    const oldMeta = exported?.meta ?? (await meta(oldUrl));
    const block = exported?.block ?? Number(record(oldMeta.block).number);
    const entity = chain === "khala" ? "claimeds" : "claimedAndBridgeds";
    const fields = `${CLAIM_FIELDS} ${chain === "khala" ? "receiver" : "l1Receiver l2Receiver"}`;
    assert.ok(
      newBlock >= block,
      `New subgraph has not reached the old ${entity} comparison block`,
    );
    const filter = {
      filter: "block_number_lte:$cutoff",
      declarations: ",$cutoff:BigInt!",
      variables: { cutoff: String(block) },
    };
    const actual = await page(endpoint(options), entity, fields, filter);
    const expected =
      exported?.claims ?? (await page(oldUrl, entity, fields, filter));
    compareClaimers(actual, expected);
    counts[entity] = {
      block,
      count: actual.length,
      source: exported ? "export" : "live",
      deployment: oldMeta.deployment,
    };
    if (chain === "phala" && !exported) {
      const unexpected = await gql(
        oldUrl,
        "query($cutoff:BigInt!){claimeds(first:1,where:{block_number_lte:$cutoff}){id}}",
        { cutoff: String(block) },
      );
      assert.equal(
        rows(unexpected.claimeds).length,
        0,
        "Phala-only Claimed entity is no longer empty: spec needs review",
      );
    }
  }
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
  const rpc = options["archive-rpc"];
  if (!rpc)
    return [
      { chain: "ethereum", status: "skipped", reason: "No ARCHIVE_RPC_URL" },
    ];
  const client = createPublicClient({
    transport: http(rpc, { timeout: 90_000, retryCount: 0 }),
  });
  const days = evidence.ethereum;
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
    const token = address("0x6c5ba91642f10282b576d91922ae6448c9d52f4e");
    const supply = await client.readContract({
      address: token,
      abi: rpcAbi,
      functionName: "totalSupply",
      blockNumber,
    });
    assert.equal(
      supply,
      integer(day.totalSupply),
      `Ethereum ${date}: raw total supply differs`,
    );
    for (const [component, holder] of Object.entries(ADDRESSES)) {
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
        `Ethereum ${date}: raw ${component} differs`,
      );
    }
    if (blockNumber >= 21596326n) {
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
  return [{ chain: "ethereum", status: "pass", samples: dates.length }];
}
async function server(options: Options, evidence: Evidence): Promise<Row> {
  const preview = required(options.preview, "--preview / SERVER_PREVIEW_URL");
  const expectedAll = record(await json(`${options["old-api"]}/api/all`));
  const actualAll = record(await json(`${preview}/api/all`));
  const oldEthereum = record(expectedAll.ethereum);
  close(
    finite(actualAll.totalCirculation),
    finite(oldEthereum.circulation) + finite(oldEthereum.portalBridge),
    1e-6,
    "/all circulation differs from old Ethereum + Portal",
  );
  close(
    finite(actualAll.totalCirculation),
    finite(record(actualAll.ethereum).circulation),
    1e-12,
    "/all total must equal Ethereum circulation",
  );
  assert.equal(actualAll.base, null, "Base compatibility field must be null");
  expectedAll.base = null;
  const oldSources = record(expectedAll.sources);
  const newSources = record(actualAll.sources);
  assert.ok(newSources.base == null, "Base source must be absent or null");
  delete oldSources.base;
  delete newSources.base;
  const oldSource = record(oldSources.ethereum);
  const newSource = record(newSources.ethereum);
  delete oldSource.headBlockNumber;
  delete oldSource.lagBlocks;
  assert.equal(typeof newSource.indexedAt, "string");
  assert.equal(typeof newSource.lagSeconds, "string");
  delete newSource.indexedAt;
  delete newSource.lagSeconds;
  assert.deepEqual(
    shape(actualAll),
    shape(expectedAll),
    "/all key sets or types differ",
  );
  const actualCirculation = await json(`${preview}/api/circulation`);
  close(
    finite(actualCirculation),
    finite(actualAll.totalCirculation),
    1e-6,
    "/circulation differs from /all",
  );

  const ethereum = dated(evidence.ethereum);
  const dates = deterministicSample([...ethereum.keys()].sort(), 30);
  evidence.oldSnapshots = await cachedSnapshots(options["snapshot-cache"]);
  for (const date of dates) {
    const actual = record(await json(`${preview}/api/snapshot?date=${date}`));
    const expected = {
      ...(await snapshot(options, evidence.oldSnapshots, date)),
      base: null,
    };
    assert.equal(actual.base, null, "Base compatibility field must be null");
    assert.deepEqual(
      shape(actual),
      shape(expected),
      `${date}: snapshot key sets or types differ`,
    );
    const day = ethereum.get(date);
    assert.ok(day);
    const snapshotValue = record(actual.ethereum);
    for (const field of [
      "circulation",
      "totalSupply",
      "reward",
      "sunsetReward",
      "phalaChainBridge",
      "sygmaBridge",
      "portalBridge",
      "vaultReward",
      "vaultUnstakeLocked",
    ])
      assert.equal(
        weiAmount(snapshotValue[field]),
        integer(day[field]),
        `${date}: snapshot ${field} differs`,
      );
    assert.equal(
      weiAmount(snapshotValue.khalaChainBridge),
      integer(day.khalaChainBridge) + integer(day.khalaLegacyChainBridge),
    );
    close(
      finite(actual.totalCirculation),
      pha(day.circulation),
      1e-12,
      `${date}: snapshot total differs`,
    );
  }
  return {
    snapshots: dates.length,
    sourceMetadataChange:
      "headBlockNumber/lagBlocks replaced by indexedAt/lagSeconds; Base source removed",
    circulationDefinition:
      "Ethereum circulation includes Portal escrow; base compatibility field is null",
  };
}

function cacheCheck(
  value: unknown,
  exported: unknown,
  evidence: Evidence,
): Row {
  const data = record(value);
  const circulation = rows(data.circulation_day);
  assert.equal(
    circulation.length,
    evidence.ethereum.length,
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
  assert.ok(
    circulation.every((row) => row.chain === "ethereum"),
    "D1 contains a non-Ethereum chain",
  );
  const actual = dated(circulation);
  assert.equal(actual.size, evidence.ethereum.length);
  const last = [...evidence.ethereum]
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
      `D1 latest Ethereum.${field} differs`,
    );
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = args(argv);
  const report: Row = {
    startedAt: new Date().toISOString(),
    stage: options["prefetch-snapshots"] ? "prefetch-snapshots" : options.stage,
    gates: {},
  };
  const gates = record(report.gates);
  try {
    if (options["prefetch-snapshots"]) {
      report.snapshots = await prefetch(options);
      report.status = "cached";
      console.log("Snapshot prefetch completed; no parity gates were run.");
      return;
    }
    const evidence = await load(options);
    report.deployments = {
      ethereum: record(evidence.meta.ethereum).deployment,
    };
    if (["subgraphs", "all"].includes(options.stage)) {
      gates["1-2"] = await balances(options, evidence);
      const exported: unknown = JSON.parse(
        await readFile(
          required(options.results, "--results / DUNE_RESULTS_JSON"),
          "utf8",
        ),
      );
      gates["3"] = await archives(
        options,
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
        Number(record(record(evidence.meta.ethereum).block).number),
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
        endpoint(options),
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
    console.log(`Parity gates passed for stage ${options.stage}, Ethereum`);
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
