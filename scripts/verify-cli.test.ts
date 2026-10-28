import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { args, claimers, load, main } from "./verify";
import { type Row, record, snapshotDates, text } from "./verify-lib";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(`${import.meta.dir}/.verify-tests-`);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true });
});

test("Ethereum loading and claimer exports use independent cutoffs", async () => {
  const requests: { path: string; query: string; cutoff: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = record(await request.json());
      const query = text(body.query);
      const variables = record(body.variables);
      requests.push({ path, query, cutoff: variables.cutoff });
      if (path !== "/ethereum") return new Response(null, { status: 410 });
      let data: Row;
      if (query.includes("_meta"))
        data = {
          _meta: {
            deployment: "new",
            hasIndexingErrors: false,
            block: { number: 102, timestamp: Math.floor(Date.now() / 1000) },
          },
        };
      else if (query.includes("latest"))
        data = {
          latest: {
            timestamp: String(Math.floor(Date.now() / 1000)),
            vaultImplementationReviewed: true,
          },
        };
      else if (query.includes("chainDays"))
        data = {
          chainDays: [
            {
              id: "2026-10-10",
              date: "2026-10-10",
              vaultImplementationReviewed: true,
            },
          ],
        };
      else if (query.includes("vaultDays")) data = { vaultDays: [] };
      else if (query.includes("vaultEvents")) data = { vaultEvents: [] };
      else if (query.includes("claimedAndBridgeds"))
        data = { claimedAndBridgeds: [] };
      else if (query.includes("claimeds")) data = { claimeds: [] };
      else return new Response(null, { status: 400 });
      return Response.json({ data });
    },
  });
  try {
    const paths = [];
    for (const [chain, block] of [
      ["khala", 100],
      ["phala", 101],
    ] as const) {
      const path = `${directory}/${chain}.json`;
      paths.push(`--old-${chain}-export`, path);
      await writeFile(
        path,
        JSON.stringify({
          subgraph: `${chain}-claimer/1.0.0`,
          block,
          meta: {
            block: { number: block },
            hasIndexingErrors: false,
            deployment: chain,
          },
          claimeds: [],
          ...(chain === "phala" ? { claimedAndBridgeds: [] } : {}),
        }),
      );
    }
    const options = args([
      "--ethereum",
      `${server.url}ethereum`,
      "--old-khala",
      `${server.url}deleted-khala`,
      "--old-phala",
      `${server.url}deleted-phala`,
      ...paths,
    ]);
    const ethereum = await load(options);
    const report = await claimers(options, ethereum);
    expect(record(report.claimeds).block).toBe(100);
    expect(record(report.claimedAndBridgeds).block).toBe(101);
    expect(record(report.claimeds).source).toBe("export");
    expect(requests.every((request) => request.path === "/ethereum")).toBe(
      true,
    );
    expect(
      requests
        .filter((request) => request.query.includes("claimeds("))
        .map((request) => request.cutoff),
    ).toEqual(["100"]);
    expect(
      requests
        .filter((request) => request.query.includes("claimedAndBridgeds("))
        .map((request) => request.cutoff),
    ).toEqual(["101"]);
    ethereum.meta.ethereum = { block: { number: 100 } };
    await expect(claimers(options, ethereum)).rejects.toThrow(
      "has not reached",
    );
    for (const option of ["--chains", "--base", "--base-archive-rpc"])
      expect(() => args([option, "base"])).toThrow("Unknown option");
  } finally {
    await server.stop(true);
  }
}, 10000);

test("prefetch resumes only missing dates through yesterday without subgraph or archive inputs", async () => {
  const cachePath = `${directory}/snapshots.ndjson`;
  const output = `${directory}/report.json`;
  const dates = snapshotDates();
  const missing = [text(dates[0]), text(dates.at(-1))];
  await writeFile(
    cachePath,
    `${dates
      .filter((date) => !missing.includes(date))
      .map((date) => JSON.stringify({ date }))
      .join("\n")}\n`,
  );
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/api/snapshot" || request.method !== "GET")
        return new Response(null, { status: 400 });
      const date = url.searchParams.get("date");
      if (!date) return new Response(null, { status: 400 });
      requested.push(date);
      return Response.json({ date });
    },
  });
  try {
    const argv = [
      "--prefetch-snapshots",
      "--old-api",
      String(server.url).replace(/\/$/, ""),
      "--snapshot-cache",
      cachePath,
      "--output",
      output,
      "--ethereum",
      `${server.url}unavailable`,
    ];
    await main(argv);
    expect(requested).toEqual(missing);
    expect((await readFile(cachePath, "utf8")).trim().split("\n")).toHaveLength(
      dates.length,
    );
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report.status).toBe("cached");
    expect(report.gates).toEqual({});
    expect(report.snapshots.fetched).toBe(2);
    await main(argv);
    expect(requested).toEqual(missing);
    expect(JSON.parse(await readFile(output, "utf8")).snapshots.fetched).toBe(
      0,
    );
    expect(() => args(["--prefetch-snapshots"])).toThrow("--snapshot-cache");
  } finally {
    await server.stop(true);
  }
});

test("server gate uses cached snapshot shapes, Portal-inclusive totals and null Base", async () => {
  const wad = 10n ** 18n;
  const amount = (value: number) => String(BigInt(value) * wad);
  const day = {
    id: "2026-10-10",
    date: "2026-10-10",
    chain: "ethereum",
    totalSupply: amount(1000),
    reward: amount(875),
    sunsetReward: "0",
    phalaChainBridge: "0",
    khalaLegacyChainBridge: "0",
    khalaChainBridge: "0",
    sygmaBridge: "0",
    portalBridge: amount(25),
    vaultReward: "0",
    vaultUnstakeLocked: "0",
    circulation: amount(125),
    vaultImplementationReviewed: true,
  };
  const ethereum = {
    totalSupply: "1000",
    reward: "875",
    sunsetReward: "0",
    phalaChainBridge: "0",
    khalaChainBridge: "0",
    sygmaBridge: "0",
    portalBridge: "25",
    vaultReward: "0",
    vaultUnstakeLocked: "0",
    circulation: "100",
  };
  const oldSnapshot = {
    date: "2026-10-10T00:00:00.000000Z",
    ethereum,
    base: { totalSupply: "20", circulation: "20" },
    totalCirculation: "120",
  };
  const cachePath = `${directory}/server-snapshots.ndjson`;
  await writeFile(cachePath, `${JSON.stringify(oldSnapshot)}\n`);
  let invalidBase = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/ethereum") {
        const query = text(record(await request.json()).query);
        let data: Row;
        if (query.includes("_meta"))
          data = {
            _meta: {
              deployment: "new",
              hasIndexingErrors: false,
              block: { number: 102, timestamp: Math.floor(Date.now() / 1000) },
            },
          };
        else if (query.includes("latest"))
          data = {
            latest: {
              timestamp: String(Math.floor(Date.now() / 1000)),
              vaultImplementationReviewed: true,
            },
          };
        else if (query.includes("chainDays")) data = { chainDays: [day] };
        else if (query.includes("vaultDays")) data = { vaultDays: [] };
        else if (query.includes("vaultEvents")) data = { vaultEvents: [] };
        else return new Response(null, { status: 400 });
        return Response.json({ data });
      }
      if (path === "/old/api/all")
        return Response.json({
          ...oldSnapshot,
          sources: {
            ethereum: {
              blockNumber: "102",
              headBlockNumber: "102",
              lagBlocks: "0",
            },
            base: { blockNumber: "102" },
          },
        });
      const actual = {
        ...oldSnapshot,
        ethereum: { ...ethereum, circulation: "125" },
        base: invalidBase ? oldSnapshot.base : null,
        totalCirculation: "125",
      };
      if (path === "/preview/api/all")
        return Response.json({
          ...actual,
          sources: {
            ethereum: {
              blockNumber: "102",
              indexedAt: "2026-10-10T00:00:00Z",
              lagSeconds: "0",
            },
            base: null,
          },
        });
      if (path === "/preview/api/circulation") return new Response("125");
      if (path === "/preview/api/snapshot") return Response.json(actual);
      return new Response(null, { status: 410 });
    },
  });
  const output = `${directory}/server-report.json`;
  const argv = [
    "--stage",
    "server",
    "--ethereum",
    `${server.url}ethereum`,
    "--old-api",
    `${server.url}old`,
    "--preview",
    `${server.url}preview`,
    "--snapshot-cache",
    cachePath,
    "--output",
    output,
  ];
  try {
    await main(argv);
    const report = record(JSON.parse(await readFile(output, "utf8")));
    expect(report.status).toBe("pass");
    expect(record(record(report.gates)["7"]).snapshots).toBe(1);
    invalidBase = true;
    await expect(main(argv)).rejects.toThrow(
      "Base compatibility field must be null",
    );
    expect(JSON.parse(await readFile(output, "utf8")).status).toBe("fail");
  } finally {
    await server.stop(true);
  }
}, 15000);
