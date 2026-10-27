import assert from "node:assert/strict";

export type Row = Record<string, unknown>;
export const WAD = 10n ** 18n;
export const record = (value: unknown): Row => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected object",
  );
  return value as Row;
};
export const rows = (value: unknown): Row[] => {
  assert.ok(Array.isArray(value), "Expected rows");
  return value.map(record);
};
export const text = (value: unknown): string => {
  assert.equal(typeof value, "string", "Expected string");
  return value as string;
};
export const integer = (value: unknown): bigint => {
  const string = text(value);
  assert.match(string, /^-?\d+$/);
  return BigInt(string);
};
export const finite = (value: unknown): number => {
  assert.ok(
    typeof value === "number" || typeof value === "string",
    "Expected number",
  );
  const result = Number(value);
  assert.ok(Number.isFinite(result), "Expected finite number");
  return result;
};
export const wei = (value: unknown): bigint => {
  const string = text(value);
  assert.match(string, /^-?\d+(\.\d{1,18})?$/, "Expected PHA decimal string");
  const [whole = "", fraction = ""] = string.replace(/^-/, "").split(".");
  const result = BigInt(whole) * WAD + BigInt(fraction.padEnd(18, "0"));
  return string.startsWith("-") ? -result : result;
};
export const pha = (value: unknown): number => Number(integer(value)) / 1e18;
export const abs = (value: bigint): bigint => (value < 0n ? -value : value);
export const close = (
  actual: number,
  expected: number,
  tolerance: number,
  label: string,
): void => {
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * tolerance,
    label,
  );
};
export const utcDate = (value: unknown): string => {
  const date = text(value).slice(0, 10);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date);
  return date;
};
export const dated = (values: Row[], field = "date"): Map<string, Row> => {
  const map = new Map<string, Row>();
  for (const row of values) {
    const date = utcDate(row[field]);
    assert.ok(!map.has(date), `Duplicate date ${date}`);
    map.set(date, row);
  }
  return map;
};
export function exportRows(
  value: unknown,
  query: string,
  field: string,
): Row[] {
  return rows(record(record(record(value).results)[query]).rows).filter(
    (row) => row[field] != null,
  );
}

export const ADDRESSES: Record<string, string> = {
  reward: "0x4731bc41b3cca4c2883b8ebb68cb546d5b3b4dd6",
  sunsetReward: "0x4a396b5c9a6fbc1bc0525f24ac0a246766f3ebef",
  phalaChainBridge: "0xcd38b15a419491c7c1238b0659f65c755792e257",
  khalaLegacyChainBridge: "0x6ed3bc069cf4f87de05c04c352e8356492ec6efe",
  khalaChainBridge: "0xeec0fb4913119567cdfc0c5fc2bf8f9f9b226c2d",
  sygmaBridge: "0xc832588193cd5ed2185dada4a531e0b26ec5b830",
  portalBridge: "0x3ee18b2214aff97000d974cf647e7c347e8fa585",
  vaultBalance: "0x21d6ec8fc14caacc55afa23cba66798dab3a0ec0",
};
const ZERO = "0x0000000000000000000000000000000000000000";
export function transferDelta(transfers: Row[], component: string): bigint {
  let delta = 0n;
  for (const transfer of transfers) {
    const from = text(transfer.from).toLowerCase();
    const to = text(transfer.to).toLowerCase();
    const amount = integer(transfer.amount);
    const addresses =
      component === "khalaChainBridge"
        ? [ADDRESSES.khalaLegacyChainBridge, ADDRESSES.khalaChainBridge]
        : [ADDRESSES[component]];
    if (component === "totalSupply") {
      if (from === ZERO) delta += amount;
      if (to === ZERO) delta -= amount;
    } else {
      if (addresses.includes(from)) delta -= amount;
      if (addresses.includes(to)) delta += amount;
    }
  }
  return delta;
}
export function vaultFlow(events: Row[]): { assets: bigint; locked: bigint } {
  let assets = 0n;
  let locked = 0n;
  for (const event of events) {
    const amount = integer(event.assets);
    switch (event.kind) {
      case "Deposit":
        assets += amount;
        break;
      case "Withdraw":
        assets -= amount;
        locked += amount;
        break;
      case "Claimed":
        locked -= amount;
        break;
      case "TreasuryAssetsClaimed":
        assets -= amount;
        break;
    }
  }
  // Vault-sent deposits are distinguished by the immutable cumulative locked
  // value, supplied by compareSnapshot (not by guessing from PHA transfers).
  return { assets, locked };
}
export interface SnapshotComparison {
  transferExplained: boolean;
  accrualDelta: bigint;
  bound: bigint;
}
export function compareSnapshot(
  day: Row,
  old: Row,
  transfers: Row[],
  events: Row[],
  vault: Row | undefined,
): SnapshotComparison {
  let transferExplained = false;
  const components =
    day.chain === "base"
      ? ["totalSupply"]
      : [
          "totalSupply",
          "reward",
          "sunsetReward",
          "phalaChainBridge",
          "khalaChainBridge",
          "sygmaBridge",
          "portalBridge",
        ];
  for (const component of components) {
    const actual =
      component === "khalaChainBridge"
        ? integer(day.khalaChainBridge) + integer(day.khalaLegacyChainBridge)
        : integer(day[component]);
    const difference = wei(old[component]) - actual;
    const explained = transferDelta(transfers, component);
    assert.equal(
      difference,
      explained,
      `${day.date}: unexplained ${component} difference`,
    );
    transferExplained ||= difference !== 0n;
  }
  const flow = vaultFlow(events);
  let accrualDelta = 0n;
  let bound = 0n;
  let vaultDifference = 0n;
  if (day.chain === "ethereum") {
    const ordered = [...events].sort((a, b) =>
      Number(integer(a.logIndex) - integer(b.logIndex)),
    );
    const last = ordered.at(-1);
    const lockedDelta = last
      ? integer(last.unstakeLockedAfter) - integer(day.vaultUnstakeLocked)
      : 0n;
    assert.equal(
      wei(old.vaultUnstakeLocked) - integer(day.vaultUnstakeLocked),
      lockedDelta,
      `${day.date}: locked assets differ`,
    );
    transferExplained ||= lockedDelta !== 0n;
    vaultDifference = wei(old.vaultReward) - integer(day.vaultReward);
    const balanceDelta = transferDelta(transfers, "vaultBalance");
    transferExplained ||= balanceDelta !== 0n;
    accrualDelta = vaultDifference - balanceDelta + flow.assets + lockedDelta;
    const midnight = BigInt(
      Date.parse(`${utcDate(day.date)}T00:00:00Z`) / 1000,
    );
    const oldTimestamp = BigInt(Date.parse(text(old.timestamp)) / 1000);
    assert.ok(oldTimestamp >= midnight, "Old snapshot precedes midnight");
    bound =
      (vault ? integer(vault.rewardRate) : 0n) * (oldTimestamp - midnight) +
      10n ** 12n;
    assert.ok(
      abs(accrualDelta) <= bound,
      `${day.date}: vault accrual exceeds rate*time + 1e-6 PHA`,
    );
    // Assets+treasury is derived from old vaultReward; independent raw values
    // are checked separately in optional archive-RPC mode.
    const derivedOldSum =
      integer(day.vaultBalance) +
      balanceDelta -
      wei(old.vaultUnstakeLocked) -
      wei(old.vaultReward);
    const newSum =
      integer(day.vaultTotalAssets) + integer(day.vaultTreasuryAssets);
    assert.ok(
      abs(derivedOldSum - newSum - flow.assets) <= bound,
      `${day.date}: derived vault+treasury exceeds bound`,
    );
  }
  let circulationDelta = transferDelta(transfers, "totalSupply");
  for (const component of [
    "reward",
    "phalaChainBridge",
    "khalaChainBridge",
    "sygmaBridge",
    "portalBridge",
  ]) {
    const delta = transferDelta(transfers, component);
    transferExplained ||= delta !== 0n;
    circulationDelta -= delta;
  }
  if (day.chain === "ethereum")
    circulationDelta -=
      transferDelta(transfers, "sunsetReward") + vaultDifference;
  assert.equal(
    wei(old.circulation) - integer(day.circulation),
    circulationDelta,
    `${day.date}: unexplained circulation difference`,
  );
  return { transferExplained, accrualDelta, bound };
}

export function compareClaimers(actual: Row[], expected: Row[]): void {
  assert.equal(actual.length, expected.length, "Claimer count differs");
  const byId = new Map(actual.map((row) => [text(row.id), row]));
  assert.equal(byId.size, actual.length, "Duplicate claimer IDs");
  for (const row of expected)
    assert.deepEqual(byId.get(text(row.id)), row, `Claimer differs ${row.id}`);
}
export function compareCheckpoints(events: Row[], checkpoints: Row[]): void {
  const byId = new Map(events.map((event) => [text(event.id), event]));
  for (const checkpoint of checkpoints) {
    const event = byId.get(text(checkpoint.id));
    assert.ok(event, `Missing vault event ${checkpoint.id}`);
    assert.equal(
      event.blockNumber,
      checkpoint.blockNumber,
      "Checkpoint block differs",
    );
    assert.equal(
      event.unstakeLockedAfter,
      checkpoint.vaultUnstakeLocked,
      `Locked assets differ ${checkpoint.id}`,
    );
  }
  assert.ok(checkpoints.length > 0, "No old checkpoints checked");
}
export function compareVault(vault: Row[], expected: Row[], full = true): Row {
  if (full)
    assert.equal(expected.length, 550, "Expected 550 dated Vault export rows");
  const settled = vault.filter(
    (row) =>
      row.settlementTotalAssets != null &&
      utcDate(row.flowDate) <= "2026-10-10",
  );
  const byDate = dated(settled, "flowDate");
  assert.equal(
    settled.length,
    expected.length,
    "Extra or missing settlement days through 2026-10-10",
  );
  const unavailableRewardsDates: string[] = [];
  for (const row of expected) {
    const date = utcDate(row.day);
    const actual = byDate.get(date);
    assert.ok(actual, `Missing Vault flowDate ${date}`);
    close(
      pha(actual.settlementTotalAssets),
      finite(row.totalAssets),
      1e-12,
      `${date}: settlement assets differ`,
    );
    if (row.dailyRewards == null) unavailableRewardsDates.push(date);
    else
      close(
        pha(actual.dailyRewards),
        finite(row.dailyRewards),
        1e-12,
        `${date}: daily rewards differ`,
      );
  }
  if (full) {
    const final = byDate.get("2026-10-10");
    assert.ok(final);
    assert.equal(
      pha(final.dailyRewards),
      34930.0634765625,
      "2026-10-10 rewards differ",
    );
  }
  return {
    vaultDays: expected.length,
    rewardsCompared: expected.length - unavailableRewardsDates.length,
    unavailableRewardsDates,
    finalDailyRewards: full ? 34930.0634765625 : null,
  };
}
export function compareVaultConsistency(vault: Row[], events: Row[]): Row[] {
  const ordered = [...events].sort(
    (a, b) =>
      Number(integer(a.blockNumber) - integer(b.blockNumber)) ||
      Number(integer(a.logIndex) - integer(b.logIndex)),
  );
  const lastSettlement = new Map<string, number>();
  const dailyRewards = new Map<string, bigint>();
  ordered.forEach((event, index) => {
    if (event.kind !== "RewardsSettled") return;
    const date = new Date(Number(integer(event.timestamp)) * 1000)
      .toISOString()
      .slice(0, 10);
    lastSettlement.set(date, index);
    dailyRewards.set(
      date,
      (dailyRewards.get(date) ?? 0n) + integer(event.assets),
    );
  });
  const days = [...vault]
    .filter((day) => day.settlementTotalAssets != null)
    .sort((a, b) => text(a.flowDate).localeCompare(text(b.flowDate)));
  const residuals: Row[] = [];
  let previous: Row | undefined;
  let previousIndex: number | undefined;
  for (const day of days) {
    const date = utcDate(day.flowDate);
    const end = lastSettlement.get(date);
    assert.ok(end !== undefined, `${date}: no settlement audit event`);
    const last = ordered[end];
    assert.ok(last);
    assert.equal(
      integer(day.settlementTotalAssets),
      integer(last.settlementAssets),
      `${date}: daily settlement disagrees with raw event`,
    );
    assert.equal(
      integer(day.dailyRewards),
      dailyRewards.get(date),
      `${date}: daily rewards disagree with audit sum`,
    );
    if (previous && previousIndex !== undefined) {
      let rewards = 0n;
      let flows = 0n;
      for (const event of ordered.slice(previousIndex + 1, end + 1)) {
        const amount = integer(event.assets);
        if (event.kind === "RewardsSettled") rewards += amount;
        if (event.kind === "Deposit") flows += amount;
        if (event.kind === "Withdraw") flows -= amount;
      }
      const delta =
        integer(day.settlementTotalAssets) -
        integer(previous.settlementTotalAssets);
      const residual = delta - rewards - flows;
      residuals.push({
        date,
        previousSettlementDate: previous.flowDate,
        deltaWei: delta.toString(),
        rewardsWei: rewards.toString(),
        netDepositWithdrawWei: flows.toString(),
        residualWei: residual.toString(),
      });
      // Verified Vault.sol changes shareholder checkpoints only by rewards,
      // deposits and withdraw requests. Treasury settlement/claims do not.
      assert.equal(
        residual,
        0n,
        `${date}: definite settlement/rewards/flow contradiction`,
      );
    } else
      residuals.push({
        date,
        residualWei: null,
        reason: "First settlement day has no prior-day baseline",
      });
    previous = day;
    previousIndex = end;
  }
  return residuals;
}
export function deterministicSample<T>(
  values: T[],
  count: number,
  preferred: Set<T> = new Set(),
): T[] {
  assert.ok(Number.isInteger(count) && count >= 2, "Sample size must be >= 2");
  if (values.length <= count) return values;
  const first = values[0];
  const last = values.at(-1);
  assert.ok(first !== undefined && last !== undefined);
  const result = new Set<T>([first, last]);
  for (const value of values)
    if (preferred.has(value) && result.size < count) result.add(value);
  for (let i = 0; result.size < count && i < count; i++) {
    const value = values[Math.floor((i * (values.length - 1)) / (count - 1))];
    assert.ok(value !== undefined);
    result.add(value);
  }
  for (const value of values) {
    if (result.size === count) break;
    result.add(value);
  }
  return values.filter((value) => result.has(value));
}
export function shape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value !== "object") return typeof value;
  return Object.fromEntries(
    Object.entries(record(value))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, shape(child)]),
  );
}
