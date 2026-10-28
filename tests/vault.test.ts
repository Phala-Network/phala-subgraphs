import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  createMockedFunction,
  newMockEvent,
  test,
} from "matchstick-as";
import {
  Approval,
  Deposit,
  Transfer,
  RewardsSettled,
  Upgraded,
  Withdraw,
} from "../generated/Vault/Vault";
import { assetsAt } from "../src/assets";
import { IMPLEMENTATION, VAULT, ZERO } from "../src/constants";
import {
  handleApproval,
  handleDeposit,
  handleShareTransfer,
  handleRewardsSettled,
  handleUpgraded,
  handleWithdraw,
} from "../src/vault";
import { VaultState } from "../generated/schema";
import { Claimed as KhalaClaim } from "../generated/KhalaClaimer/KhalaClaimer";
import { handleKhalaClaimer } from "../src/claimer";
import { handleBlock } from "../src/clock";
import { block, mockVault, vaultState } from "./helpers";

afterEach(() => clearStore());
function event(): ethereum.Event {
  const e = newMockEvent();
  e.address = Address.fromString(VAULT);
  e.block.timestamp = BigInt.fromI32(1588204810);
  return e;
}
test("Upgraded refreshes all checkpoints and rate before future accrual", () => {
  const old = vaultState();
  old.save();
  mockVault(1588204810, 2000, 100, 10, 2000, 200, false);
  const upgraded = changetype<Upgraded>(event());
  upgraded.parameters = [
    new ethereum.EventParam(
      "implementation",
      ethereum.Value.fromAddress(Address.fromString(IMPLEMENTATION)),
    ),
  ];
  handleUpgraded(upgraded);
  const state = VaultState.load("current");
  if (state == null) throw new Error("Expected state");
  assert.bigIntEquals(
    assetsAt(state, BigInt.fromI32(1588204820)).total,
    BigInt.fromI32(2080),
  );
  assert.bigIntEquals(
    assetsAt(state, BigInt.fromI32(1588204820)).treasury,
    BigInt.fromI32(120),
  );
  assert.fieldEquals("VaultState", "current", "shareSupply", "200");
  assert.entityCount("VaultEvent", 1);
});
test("unknown implementations keep indexing in checkpoint-only mode", () => {
  mockVault();
  const upgraded = changetype<Upgraded>(event());
  upgraded.parameters = [
    new ethereum.EventParam(
      "implementation",
      ethereum.Value.fromAddress(
        Address.fromString("0x0000000000000000000000000000000000000001"),
      ),
    ),
  ];
  handleUpgraded(upgraded);
  const state = VaultState.load("current");
  if (state == null) throw new Error("Expected state");
  assert.bigIntEquals(
    assetsAt(state, BigInt.fromI32(1588204820)).total,
    BigInt.fromI32(1000),
  );
  assert.fieldEquals(
    "Latest",
    "current",
    "vaultImplementationReviewed",
    "false",
  );
  assert.fieldEquals("Latest", "current", "accrualMode", "checkpoint-only");
  assert.entityCount("VaultEvent", 1);
  const claim = changetype<KhalaClaim>(newMockEvent());
  claim.block.timestamp = BigInt.fromI32(1588204820);
  claim.parameters = [
    new ethereum.EventParam(
      "user",
      ethereum.Value.fromAddress(Address.fromString(VAULT)),
    ),
    new ethereum.EventParam(
      "free",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)),
    ),
    new ethereum.EventParam(
      "staked",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2)),
    ),
    new ethereum.EventParam(
      "receiver",
      ethereum.Value.fromAddress(Address.fromString(VAULT)),
    ),
  ];
  handleKhalaClaimer(claim);
  assert.entityCount("Claimed", 1);
  handleBlock(block(1588291200));
  assert.fieldEquals(
    "ChainDay",
    "2020-05-01",
    "vaultImplementationReviewed",
    "false",
  );
  assert.fieldEquals(
    "VaultDay",
    "2020-05-01",
    "accrualMode",
    "checkpoint-only",
  );
});
test("unknown ABI getter reverts preserve the last complete checkpoint", () => {
  const previous = vaultState();
  previous.save();
  mockVault(1588204810, 2000);
  createMockedFunction(
    Address.fromString(VAULT),
    "checkpointTime",
    "checkpointTime():(uint256)",
  ).reverts();
  const upgraded = changetype<Upgraded>(event());
  upgraded.parameters = [
    new ethereum.EventParam(
      "implementation",
      ethereum.Value.fromAddress(
        Address.fromString("0x0000000000000000000000000000000000000001"),
      ),
    ),
  ];
  handleUpgraded(upgraded);
  assert.fieldEquals("VaultState", "current", "checkpointTotalAssets", "1000");
  assert.fieldEquals("Latest", "current", "vaultTotalAssets", "1000");
  assert.fieldEquals(
    "Latest",
    "current",
    "vaultImplementationReviewed",
    "false",
  );
});
test("Holder count follows positive balances and self transfers", () => {
  mockVault();
  const user = Address.fromString("0x0000000000000000000000000000000000000001");
  const mint = changetype<Transfer>(event());
  mint.parameters = [
    new ethereum.EventParam(
      "from",
      ethereum.Value.fromAddress(Address.fromString(ZERO)),
    ),
    new ethereum.EventParam("to", ethereum.Value.fromAddress(user)),
    new ethereum.EventParam(
      "value",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(100)),
    ),
  ];
  handleShareTransfer(mint);
  assert.fieldEquals("VaultState", "current", "stakers", "1");
  mint.logIndex = BigInt.fromI32(2);
  mint.parameters[0] = new ethereum.EventParam(
    "from",
    ethereum.Value.fromAddress(user),
  );
  handleShareTransfer(mint);
  assert.fieldEquals("VaultState", "current", "stakers", "1");
  mint.logIndex = BigInt.fromI32(3);
  mint.parameters[1] = new ethereum.EventParam(
    "to",
    ethereum.Value.fromAddress(Address.fromString(ZERO)),
  );
  handleShareTransfer(mint);
  assert.fieldEquals("VaultState", "current", "stakers", "0");
});
test("unstake then vault-sent redeposit leaves an immutable lock audit", () => {
  mockVault();
  const withdraw = changetype<Withdraw>(event());
  const user = Address.fromString("0x0000000000000000000000000000000000000001");
  withdraw.parameters = [
    new ethereum.EventParam("sender", ethereum.Value.fromAddress(user)),
    new ethereum.EventParam("receiver", ethereum.Value.fromAddress(user)),
    new ethereum.EventParam("owner", ethereum.Value.fromAddress(user)),
    new ethereum.EventParam(
      "assets",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(50)),
    ),
    new ethereum.EventParam(
      "shares",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(5)),
    ),
  ];
  handleWithdraw(withdraw);
  assert.fieldEquals("VaultState", "current", "unstakeLocked", "50");
  const deposit = changetype<Deposit>(event());
  deposit.logIndex = BigInt.fromI32(2);
  deposit.parameters = [
    new ethereum.EventParam(
      "sender",
      ethereum.Value.fromAddress(Address.fromString(VAULT)),
    ),
    new ethereum.EventParam("owner", ethereum.Value.fromAddress(user)),
    new ethereum.EventParam(
      "assets",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(50)),
    ),
    new ethereum.EventParam(
      "shares",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(5)),
    ),
  ];
  handleDeposit(deposit);
  assert.fieldEquals("VaultState", "current", "unstakeLocked", "0");
  assert.entityCount("VaultEvent", 2);
});

test("settlement counters keep raw last values separate from midnight accrual", () => {
  mockVault(1588204810, 1025);
  const settled = changetype<RewardsSettled>(event());
  settled.parameters = [
    new ethereum.EventParam(
      "checkpointTime",
      ethereum.Value.fromUnsignedBigInt(settled.block.timestamp),
    ),
    new ethereum.EventParam(
      "rewards",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(10)),
    ),
    new ethereum.EventParam(
      "totalAssets",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1010)),
    ),
  ];
  handleRewardsSettled(settled);
  settled.logIndex = BigInt.fromI32(2);
  settled.parameters[1] = new ethereum.EventParam(
    "rewards",
    ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(15)),
  );
  settled.parameters[2] = new ethereum.EventParam(
    "totalAssets",
    ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1025)),
  );
  handleRewardsSettled(settled);
  handleBlock(block(1588291200));
  assert.fieldEquals("VaultDay", "2020-05-01", "dailyRewards", "25");
  assert.fieldEquals("VaultDay", "2020-05-01", "settlementTotalAssets", "1025");
  assert.fieldEquals(
    "VaultEvent",
    settled.transaction.hash.concatI32(2).toHexString(),
    "settlementAssets",
    "1025",
  );
});

test("pre-Upgraded logs with a new treasury ratio flag checkpoint-only without halting", () => {
  const previous = vaultState();
  previous.save();
  // This earlier log reads the later upgrade's end-of-block getters, while
  // our stored implementation address still names the reviewed contract.
  mockVault(1588204810, 2000, 100, 10, 10001);
  const approval = changetype<Approval>(event());
  approval.logIndex = BigInt.fromI32(1);
  handleApproval(approval);
  assert.fieldEquals("VaultState", "current", "implementation", IMPLEMENTATION);
  assert.fieldEquals(
    "VaultState",
    "current",
    "vaultImplementationReviewed",
    "false",
  );
  assert.fieldEquals("Latest", "current", "accrualMode", "checkpoint-only");
  assert.fieldEquals("Latest", "current", "vaultTotalAssets", "2000");
  const upgraded = changetype<Upgraded>(event());
  upgraded.logIndex = BigInt.fromI32(2);
  upgraded.parameters = [
    new ethereum.EventParam(
      "implementation",
      ethereum.Value.fromAddress(
        Address.fromString("0x0000000000000000000000000000000000000001"),
      ),
    ),
  ];
  handleUpgraded(upgraded);
  assert.entityCount("VaultEvent", 2);
  handleBlock(block(1588291200));
  assert.fieldEquals(
    "ChainDay",
    "2020-05-01",
    "vaultImplementationReviewed",
    "false",
  );
});
test("future checkpoint evaluation persists checkpoint-only instead of halting", () => {
  const state = vaultState();
  const amounts = assetsAt(
    state,
    state.checkpointTime.minus(BigInt.fromI32(1)),
  );
  assert.bigIntEquals(amounts.total, BigInt.fromI32(1000));
  assert.bigIntEquals(amounts.treasury, BigInt.fromI32(20));
  assert.fieldEquals(
    "VaultState",
    "current",
    "vaultImplementationReviewed",
    "false",
  );
  assert.fieldEquals("VaultState", "current", "accrualMode", "checkpoint-only");
});
