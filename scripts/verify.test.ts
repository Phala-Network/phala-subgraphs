import { describe, expect, test } from "bun:test";
import {
  ADDRESSES,
  circulationTotal,
  claimerExport,
  compareCheckpoints,
  compareClaimers,
  compareSnapshot,
  compareVault,
  compareVaultConsistency,
  deterministicSample,
  type Row,
  selectedChains,
  snapshotDates,
  transferDelta,
  wei,
} from "./verify-lib";

const ZERO = "0x0000000000000000000000000000000000000000";
const day: Row = {
  date: "2026-10-10",
  chain: "ethereum",
  totalSupply: "1000",
  reward: "100",
  sunsetReward: "0",
  phalaChainBridge: "0",
  khalaLegacyChainBridge: "20",
  khalaChainBridge: "30",
  sygmaBridge: "0",
  portalBridge: "0",
  vaultBalance: "100",
  vaultTotalAssets: "40",
  vaultTreasuryAssets: "10",
  vaultUnstakeLocked: "20",
  vaultReward: "30",
  circulation: "820",
};
const old: Row = {
  blockNumber: "123",
  timestamp: "2026-10-10T00:00:11Z",
  totalSupply: "0.000000000000001",
  reward: "0.0000000000000001",
  sunsetReward: "0",
  phalaChainBridge: "0",
  khalaChainBridge: "0.00000000000000005",
  sygmaBridge: "0",
  portalBridge: "0",
  vaultReward: "0.00000000000000003",
  vaultUnstakeLocked: "0.00000000000000002",
  circulation: "0.00000000000000082",
};
const transfer = (from: string, to: string, amount: string): Row => ({
  from,
  to,
  amount,
});
describe("exact balances and explained first-block differences", () => {
  test("merges the two Khala addresses and keeps all arithmetic in wei", () => {
    expect(compareSnapshot(day, old, [], [], undefined).transferExplained).toBe(
      false,
    );
    expect(wei("-1.000000000000000001")).toBe(-1000000000000000001n);
    expect(() => wei("1e3")).toThrow();
  });
  test("only the audited signed transfer sum permits a component mismatch", () => {
    const expected = {
      ...old,
      reward: "0.00000000000000009",
      circulation: "0.00000000000000083",
    };
    const events = [transfer(ADDRESSES.reward ?? "", "0x1234", "10")];
    expect(
      compareSnapshot(day, expected, events, [], undefined).transferExplained,
    ).toBe(true);
    expect(() => compareSnapshot(day, expected, [], [], undefined)).toThrow(
      "unexplained reward",
    );
    expect(
      transferDelta(
        [
          transfer(
            ADDRESSES.khalaLegacyChainBridge ?? "",
            ADDRESSES.khalaChainBridge ?? "",
            "10",
          ),
        ],
        "khalaChainBridge",
      ),
    ).toBe(0n);
    expect(
      transferDelta([transfer(ZERO, "0x1234", "100")], "totalSupply"),
    ).toBe(100n);
  });
  test("vault accrual is bounded by the midnight rate and block delay", () => {
    const accrued = {
      ...old,
      vaultReward: "0.000000000000000008",
      circulation: "0.000000000000000842",
    };
    expect(
      compareSnapshot(day, accrued, [], [], { rewardRate: "2" }).accrualDelta,
    ).toBe(-22n);
    const impossible = {
      ...old,
      vaultReward: "-0.1",
      circulation: "0.10000000000000085",
    };
    expect(() =>
      compareSnapshot(day, impossible, [], [], { rewardRate: "2" }),
    ).toThrow("exceeds");
  });
  test("Base circulation accounts for excluded transfers even though the old API omits their balances", () => {
    const base = { ...day, chain: "base", circulation: "850" };
    const expected = {
      totalSupply: old.totalSupply,
      circulation: "0.00000000000000086",
    };
    expect(() =>
      compareSnapshot(
        base,
        expected,
        [transfer(ADDRESSES.reward ?? "", "0x1234", "10")],
        [],
        undefined,
      ),
    ).not.toThrow();
    expect(() => compareSnapshot(base, expected, [], [], undefined)).toThrow();
  });
});
test("claimer parity compares every field and the complete ID set", () => {
  const row = { id: "0xabc-12", contractId_: "0x123", user: null, free: "10" };
  compareClaimers([row], [row]);
  expect(() => compareClaimers([{ ...row, free: "11" }], [row])).toThrow();
  expect(() => compareClaimers([], [row])).toThrow();
});
const exportedClaim: Row = {
  id: "0xabc-12",
  block_number: "100",
  timestamp_: "1791504001",
  transactionHash_: "0xabc",
  contractId_: "0x123",
  user: null,
  free: "10",
  staked: "20",
  receiver: null,
};
test("exported claims require the complete schema, unique IDs and an indexed cutoff", () => {
  const value = {
    subgraph: "khala-claimer/1.0.0",
    block: 100,
    meta: {
      block: { number: 100 },
      hasIndexingErrors: false,
      deployment: "Qm",
    },
    claimeds: [exportedClaim],
  };
  expect(claimerExport(value, "khala").claims).toEqual([exportedClaim]);
  expect(() => claimerExport(value, "phala")).toThrow("subgraph differs");
  expect(() => claimerExport({ ...value, block: 99 }, "khala")).toThrow(
    "meta block",
  );
  expect(() =>
    claimerExport(
      { ...value, claimeds: [exportedClaim, exportedClaim] },
      "khala",
    ),
  ).toThrow("duplicate");
  expect(() =>
    claimerExport(
      { ...value, claimeds: [{ ...exportedClaim, block_number: "101" }] },
      "khala",
    ),
  ).toThrow("exceeds");
  const { contractId_: _, ...missingField } = exportedClaim;
  expect(() =>
    claimerExport({ ...value, claimeds: [missingField] }, "khala"),
  ).toThrow("fields differ");
  const phala = {
    ...value,
    subgraph: "phala-claimer/1.0.0",
    claimeds: [],
    claimedAndBridgeds: [],
  };
  expect(claimerExport(phala, "phala").claims).toEqual([]);
  expect(() =>
    claimerExport({ ...phala, claimeds: undefined }, "phala"),
  ).toThrow();
  expect(() =>
    claimerExport({ ...phala, claimeds: [exportedClaim] }, "phala"),
  ).toThrow("no longer empty");
});
test("partial totals use only selected new chains, old API counterparts, and zero Base before deployment", () => {
  const days = {
    ethereum: { circulation: "2000000000000000000" },
    base: { circulation: "3000000000000000000" },
  };
  const snapshot = {
    ethereum: { circulation: "20" },
    base: { circulation: "30" },
  };
  expect(circulationTotal("2026-10-10", ["ethereum"], days, snapshot)).toBe(32);
  expect(circulationTotal("2026-10-10", ["base"], days, snapshot)).toBe(23);
  expect(
    circulationTotal("2026-10-10", ["ethereum", "base"], days, undefined),
  ).toBe(5);
  expect(
    circulationTotal("2021-02-08", ["base"], {}, { ...snapshot, base: null }),
  ).toBe(20);
  expect(() => circulationTotal("2026-10-10", ["base"], {}, snapshot)).toThrow(
    "base date missing",
  );
  expect(() =>
    circulationTotal("2026-10-10", ["base"], days, undefined),
  ).toThrow("hybrid total");
});
test("chain selection rejects ambiguous inputs and prefetch ends at UTC yesterday", () => {
  expect(selectedChains("base")).toEqual(["base"]);
  expect(selectedChains("base,ethereum")).toEqual(["ethereum", "base"]);
  for (const invalid of ["", "all", "ethereum,ethereum", "ethereum,base,other"])
    expect(() => selectedChains(invalid)).toThrow("--chains");
  const dates = snapshotDates(Date.parse("2026-10-27T00:01:00Z"));
  expect(dates[0]).toBe("2020-04-30");
  expect(dates.at(-1)).toBe("2026-10-26");
  expect(dates).not.toContain("2026-10-27");
  expect(snapshotDates(Date.parse("2024-03-01T23:59:59Z"))).toContain(
    "2024-02-29",
  );
});
test("checkpoint gate uses immutable event IDs and exact cumulative locked assets", () => {
  const checkpoints = [
    { id: "0xabc", blockNumber: "12", vaultUnstakeLocked: "50" },
  ];
  compareCheckpoints(
    [{ id: "0xabc", blockNumber: "12", unstakeLockedAfter: "50" }],
    checkpoints,
  );
  expect(() =>
    compareCheckpoints(
      [{ id: "0xabc", blockNumber: "12", unstakeLockedAfter: "51" }],
      checkpoints,
    ),
  ).toThrow();
});
test("Dune parity compares flowDate settlements and rewards, and rejects extra dates", () => {
  const expected = [{ day: "2026-10-10", totalAssets: 1, dailyRewards: 2 }];
  const actual = [
    {
      date: "2026-10-11",
      flowDate: "2026-10-10",
      settlementTotalAssets: "1000000000000000000",
      dailyRewards: "2000000000000000000",
    },
  ];
  compareVault(actual, expected, false);
  expect(() =>
    compareVault([{ ...actual[0], dailyRewards: "0" }], expected, false),
  ).toThrow();
  expect(() =>
    compareVault(
      [...actual, { ...actual[0], flowDate: "2026-10-09" }],
      expected,
      false,
    ),
  ).toThrow();
});
test("sampling is deterministic, includes endpoints and prioritizes transfer dates", () => {
  const values = Array.from({ length: 100 }, (_, index) => String(index));
  const sampled = deterministicSample(values, 30, new Set(["17", "23"]));
  expect(sampled).toHaveLength(30);
  expect(sampled).toContain("0");
  expect(sampled).toContain("99");
  expect(sampled).toContain("17");
  expect(sampled).toContain("23");
  expect(deterministicSample(values, 30, new Set(["17", "23"]))).toEqual(
    sampled,
  );
});

test("unavailable Dune rewards are reported, never interpreted as zero", () => {
  const actual = [
    {
      flowDate: "2026-10-09",
      settlementTotalAssets: "1000000000000000000",
      dailyRewards: "1230000000000000000",
    },
  ];
  const result = compareVault(
    actual,
    [{ day: "2026-10-09", totalAssets: 1 }],
    false,
  );
  expect(result.rewardsCompared).toBe(0);
  expect(result.unavailableRewardsDates).toEqual(["2026-10-09"]);
});
test("settlement consistency accounts for flows after the prior day's last settlement", () => {
  const event = (
    kind: string,
    assets: string,
    index: string,
    timestamp: string,
    settlementAssets: string | null = null,
  ): Row => ({
    kind,
    assets,
    logIndex: index,
    timestamp,
    settlementAssets,
    blockNumber: "123",
  });
  const events = [
    event("RewardsSettled", "5", "1", "1791504001", "100"), // Oct 9
    event("Deposit", "20", "2", "1791504002"), // after the Oct 9 settlement
    event("Withdraw", "3", "3", "1791590401"), // Oct 10
    event("RewardsSettled", "7", "4", "1791590402", "124"),
    event("Deposit", "99", "5", "1791590403"), // after Oct 10's last settlement
  ];
  const days = [
    { flowDate: "2026-10-09", settlementTotalAssets: "100", dailyRewards: "5" },
    { flowDate: "2026-10-10", settlementTotalAssets: "124", dailyRewards: "7" },
  ];
  expect(compareVaultConsistency(days, events).at(-1)?.residualWei).toBe("0");
  expect(() =>
    compareVaultConsistency(
      [{ ...days[0] }, { ...days[1], settlementTotalAssets: "125" }],
      events,
    ),
  ).toThrow();
  const incorrectFlows = events.map((row) =>
    row.kind === "Withdraw" ? { ...row, assets: "4" } : row,
  );
  expect(() => compareVaultConsistency(days, incorrectFlows)).toThrow(
    "contradiction",
  );
});
