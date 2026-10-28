import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { args, claimers, load, main } from "./verify";
import { type Row, record, snapshotDates, text } from "./verify-lib";

let directory: string;
beforeAll(async () => {
  await mkdir("/tmp/phala-subgraphs-pr1", { recursive: true });
  directory = await mkdtemp("/tmp/phala-subgraphs-pr1/verify-tests-");
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true });
});

test("per-chain loading avoids unavailable deployments; exports use independent cutoffs", async () => {
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
      if (!["/ethereum", "/base"].includes(path))
        return new Response(null, { status: 410 });
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
    const base = await load(
      args([
        "--chains",
        "base",
        "--base",
        `${server.url}base`,
        "--ethereum",
        `${server.url}unavailable`,
      ]),
    );
    expect(base.ethereum).toEqual([]);
    expect(base.meta.ethereum).toBeUndefined();
    expect(requests.every((request) => request.path === "/base")).toBe(true);
    requests.length = 0;
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
      "--chains",
      "ethereum",
      "--ethereum",
      `${server.url}ethereum`,
      "--base",
      `${server.url}unavailable`,
      "--old-khala",
      `${server.url}deleted-khala`,
      "--old-phala",
      `${server.url}deleted-phala`,
      ...paths,
    ]);
    const ethereum = await load(options);
    expect(ethereum.base).toEqual([]);
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
    expect(() => args(["--stage", "all", "--chains", "ethereum"])).toThrow(
      "both chains",
    );
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
      "--base",
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
