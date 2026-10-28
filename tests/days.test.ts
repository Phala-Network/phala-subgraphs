import { BigInt } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, test } from "matchstick-as";
import { ChainState } from "../generated/schema";
import { assetsAt, apr } from "../src/assets";
import { handleBlock } from "../src/clock";
import { closeDaysUpTo } from "../src/days";
import { chainState } from "../src/state";
import { block, vaultState } from "./helpers";

afterEach(() => clearStore());
test("gap fill at exact midnight, with observed metadata and zero quiet-day flows", () => {
  const first = block(1588204801, 123);
  closeDaysUpTo(first);
  const state = chainState();
  state.totalSupply = BigInt.fromI32(10000);
  state.observedBlockNumber = first.number;
  state.observedBlockTimestamp = first.timestamp;
  state.save();
  const vault = vaultState();
  vault.dailyRewards = BigInt.fromI32(8);
  vault.settlementTotalAssets = BigInt.fromI32(1000);
  vault.save();
  handleBlock(block(1588464001, 999));
  assert.entityCount("ChainDay", 4);
  assert.entityCount("VaultDay", 3);
  assert.fieldEquals("ChainDay", "2020-05-01", "timestamp", "1588291200");
  assert.fieldEquals("ChainDay", "2020-05-01", "observedBlockNumber", "123");
  assert.fieldEquals("VaultDay", "2020-05-01", "flowDate", "2020-04-30");
  assert.fieldEquals("VaultDay", "2020-05-01", "dailyRewards", "8");
  assert.fieldEquals("VaultDay", "2020-05-02", "dailyRewards", "0");
  assert.fieldEquals("Latest", "current", "observedBlockNumber", "999");
  // Closing twice never tries to rewrite immutable entities.
  handleBlock(block(1588464002, 1000));
  assert.entityCount("ChainDay", 4);
});
test("treasury basis-point floor and reward conservation", () => {
  const state = vaultState();
  const amounts = assetsAt(state, BigInt.fromI32(1588204801));
  assert.bigIntEquals(amounts.total, BigInt.fromI32(1005));
  assert.bigIntEquals(amounts.treasury, BigInt.fromI32(22));
});
test("paused and zero share supply stop both accrual and APR", () => {
  const state = vaultState();
  state.paused = true;
  assert.bigIntEquals(
    assetsAt(state, BigInt.fromI32(1588204810)).total,
    BigInt.fromI32(1000),
  );
  assert.stringEquals(apr(state, BigInt.fromI32(1000)).toString(), "0");
  state.paused = false;
  state.shareSupply = BigInt.zero();
  assert.bigIntEquals(
    assetsAt(state, BigInt.fromI32(1588204810)).treasury,
    BigInt.fromI32(20),
  );
  assert.stringEquals(apr(state, BigInt.fromI32(1000)).toString(), "0");
});

test("circulation excludes every reserve and Vault reward, while Portal escrow still circulates", () => {
  const state = chainState();
  state.totalSupply = BigInt.fromI32(10000);
  state.reward = BigInt.fromI32(100);
  state.sunsetReward = BigInt.fromI32(200);
  state.phalaChainBridge = BigInt.fromI32(300);
  state.khalaLegacyChainBridge = BigInt.fromI32(400);
  state.khalaChainBridge = BigInt.fromI32(500);
  state.sygmaBridge = BigInt.fromI32(600);
  state.portalBridge = BigInt.fromI32(700);
  state.vaultBalance = BigInt.fromI32(2000);
  state.save();
  const vault = vaultState();
  vault.paused = true;
  vault.unstakeLocked = BigInt.fromI32(30);
  vault.save();
  handleBlock(block(1588204801));
  assert.fieldEquals("Latest", "current", "portalBridge", "700");
  assert.fieldEquals("Latest", "current", "vaultReward", "950");
  assert.fieldEquals("Latest", "current", "circulation", "6950");
  handleBlock(block(1588291201));
  assert.fieldEquals("ChainDay", "2020-05-01", "portalBridge", "700");
  assert.fieldEquals("ChainDay", "2020-05-01", "circulation", "6950");
  const current = chainState();
  current.vaultBalance = BigInt.fromI32(1000);
  current.save();
  handleBlock(block(1588291202));
  assert.fieldEquals("Latest", "current", "vaultReward", "-50");
  assert.fieldEquals("Latest", "current", "circulation", "7950");
});
