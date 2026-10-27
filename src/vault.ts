import {
  Address,
  BigInt,
  Bytes,
  ethereum,
  Value,
} from "@graphprotocol/graph-ts";
import {
  Approval,
  Claimed,
  Deposit,
  Initialized,
  MaxUnlockRequestsUpdated,
  OwnershipTransferred,
  Paused,
  RewardRateUpdated,
  RewardsSettled,
  Transfer,
  TreasuryAssetsClaimed,
  TreasuryRatioUpdated,
  TreasurySettled,
  UnlockPeriodUpdated,
  Unpaused,
  Upgraded,
  Vault,
  Withdraw,
} from "../generated/Vault/Vault";
import { Holder, VaultEvent, VaultState } from "../generated/schema";
import { markUnreviewed } from "./assets";
import { FLOW_FIELDS, IMPLEMENTATION, VAULT, ZERO } from "./constants";
import { closeDaysUpTo, refreshLatest } from "./days";

function loadVault(): VaultState {
  let state = VaultState.load("current");
  if (state != null) return state;
  state = new VaultState("current");
  state.implementation = Bytes.fromHexString(IMPLEMENTATION);
  state.vaultImplementationReviewed = true;
  state.accrualMode = "formula";
  state.checkpointTime = BigInt.zero();
  state.checkpointTotalAssets = BigInt.zero();
  state.checkpointTreasuryAssets = BigInt.zero();
  state.rewardRate = BigInt.zero();
  state.treasuryRatio = BigInt.zero();
  state.shareSupply = BigInt.zero();
  state.paused = true;
  state.stakers = BigInt.zero();
  state.unstakeLocked = BigInt.zero();
  for (let i = 0; i < FLOW_FIELDS.length; i++)
    state.set(FLOW_FIELDS[i], Value.fromBigInt(BigInt.zero()));
  return state;
}
// All calls are declared on every event in ethereum.yaml. They read end-of-
// block storage, so the last event in each block leaves a coherent checkpoint.
// Daily closure happens BEFORE the first call in a new day.
function begin(
  event: ethereum.Event,
  implementation: Address | null = null,
): VaultState {
  closeDaysUpTo(event.block);
  const state = loadVault();
  if (implementation !== null) state.implementation = implementation;
  state.vaultImplementationReviewed =
    state.implementation.toHexString() == IMPLEMENTATION;
  state.accrualMode = state.vaultImplementationReviewed
    ? "formula"
    : "checkpoint-only";
  const contract = Vault.bind(event.address);
  const time = contract.try_checkpointTime();
  const total = contract.try_checkpointTotalAssets();
  const treasury = contract.try_checkpointTreasuryAssets();
  const rate = contract.try_rewardRate();
  const ratio = contract.try_treasuryRatio();
  const paused = contract.try_paused();
  const supply = contract.try_totalSupply();
  if (
    !time.reverted &&
    !total.reverted &&
    !treasury.reverted &&
    !rate.reverted &&
    !ratio.reverted &&
    !paused.reverted &&
    !supply.reverted
  ) {
    state.checkpointTime = time.value;
    state.checkpointTotalAssets = total.value;
    state.checkpointTreasuryAssets = treasury.value;
    state.rewardRate = rate.value;
    state.treasuryRatio = ratio.value;
    state.paused = paused.value;
    state.shareSupply = supply.value;
  } else {
    // An unknown ABI may remove getters. Retain the last complete checkpoint
    // and keep claimers alive; consumers must reject the unreviewed flag.
    // Earlier logs in an upgrade block also read the new end-of-block ABI,
    // before the Upgraded log has updated our implementation address.
    markUnreviewed(state);
  }
  if (
    state.treasuryRatio.gt(BigInt.fromI32(10000)) ||
    state.checkpointTime.gt(event.block.timestamp)
  )
    markUnreviewed(state);
  return state;
}
function finish(
  event: ethereum.Event,
  state: VaultState,
  kind: string,
  assets: BigInt,
  shares: BigInt,
  settlementAssets: BigInt | null = null,
): void {
  if (state.vaultImplementationReviewed)
    assert(state.unstakeLocked.ge(BigInt.zero()), "Negative locked assets");
  state.save();
  const record = new VaultEvent(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
  );
  record.kind = kind;
  record.settlementAssets = settlementAssets;
  record.assets = assets;
  record.shares = shares;
  record.blockNumber = event.block.number;
  record.timestamp = event.block.timestamp;
  record.transactionHash = event.transaction.hash;
  record.logIndex = event.logIndex;
  record.unstakeLockedAfter = state.unstakeLocked;
  record.checkpointTime = state.checkpointTime;
  record.checkpointTotalAssets = state.checkpointTotalAssets;
  record.checkpointTreasuryAssets = state.checkpointTreasuryAssets;
  record.rewardRate = state.rewardRate;
  record.treasuryRatio = state.treasuryRatio;
  record.shareSupply = state.shareSupply;
  record.paused = state.paused;
  record.implementation = state.implementation;
  record.vaultImplementationReviewed = state.vaultImplementationReviewed;
  record.accrualMode = state.accrualMode;
  record.save();
  refreshLatest(event.block);
}
function add(state: VaultState, field: string, amount: BigInt): void {
  const previous = state.get(field);
  assert(previous != null, "Missing vault flow counter");
  if (previous != null)
    state.set(field, Value.fromBigInt(previous.toBigInt().plus(amount)));
}
export function handleWithdraw(event: Withdraw): void {
  const state = begin(event);
  state.unstakeLocked = state.unstakeLocked.plus(event.params.assets);
  add(state, "withdrawRequests", event.params.assets);
  add(state, "withdrawRequestCount", BigInt.fromI32(1));
  finish(event, state, "Withdraw", event.params.assets, event.params.shares);
}
export function handleClaimed(event: Claimed): void {
  const state = begin(event);
  state.unstakeLocked = state.unstakeLocked.minus(event.params.assets);
  add(state, "claims", event.params.assets);
  add(state, "claimCount", BigInt.fromI32(1));
  finish(event, state, "Claimed", event.params.assets, BigInt.zero());
}
export function handleDeposit(event: Deposit): void {
  const state = begin(event);
  if (event.params.sender.toHexString() == VAULT)
    state.unstakeLocked = state.unstakeLocked.minus(event.params.assets);
  add(state, "deposits", event.params.assets);
  add(state, "depositCount", BigInt.fromI32(1));
  finish(event, state, "Deposit", event.params.assets, event.params.shares);
}
export function handleRewardsSettled(event: RewardsSettled): void {
  const state = begin(event);
  add(state, "dailyRewards", event.params.rewards);
  state.settlementTotalAssets = event.params.totalAssets;
  finish(
    event,
    state,
    "RewardsSettled",
    event.params.rewards,
    BigInt.zero(),
    event.params.totalAssets,
  );
}
export function handleTreasurySettled(event: TreasurySettled): void {
  const state = begin(event);
  add(state, "dailyTreasuryRewards", event.params.treasuryRewards);
  add(state, "treasurySettlementCount", BigInt.fromI32(1));
  finish(
    event,
    state,
    "TreasurySettled",
    event.params.treasuryRewards,
    BigInt.zero(),
    event.params.treasuryAssets,
  );
}
export function handleTreasuryAssetsClaimed(
  event: TreasuryAssetsClaimed,
): void {
  const state = begin(event);
  add(state, "treasuryClaims", event.params.assets);
  finish(
    event,
    state,
    "TreasuryAssetsClaimed",
    event.params.assets,
    BigInt.zero(),
  );
}
function updateHolder(state: VaultState, owner: Address, delta: BigInt): void {
  if (owner.toHexString() == ZERO) return;
  let holder = Holder.load(owner);
  if (holder == null) {
    holder = new Holder(owner);
    holder.shares = BigInt.zero();
  }
  const wasActive = holder.shares.gt(BigInt.zero());
  holder.shares = holder.shares.plus(delta);
  if (state.vaultImplementationReviewed)
    assert(holder.shares.ge(BigInt.zero()), "Negative share balance");
  const active = holder.shares.gt(BigInt.zero());
  if (wasActive != active)
    state.stakers = state.stakers.plus(BigInt.fromI32(active ? 1 : -1));
  holder.save();
}
export function handleShareTransfer(event: Transfer): void {
  const state = begin(event);
  if (!event.params.from.equals(event.params.to)) {
    updateHolder(state, event.params.from, event.params.value.neg());
    updateHolder(state, event.params.to, event.params.value);
  }
  finish(event, state, "Transfer", BigInt.zero(), event.params.value);
}
export function handleUpgraded(event: Upgraded): void {
  const state = begin(event, event.params.implementation);
  finish(event, state, "Upgraded", BigInt.zero(), BigInt.zero());
}
function administration(event: ethereum.Event, kind: string): void {
  const state = begin(event);
  finish(event, state, kind, BigInt.zero(), BigInt.zero());
}
export function handleApproval(event: Approval): void {
  administration(event, "Approval");
}
export function handleInitialized(event: Initialized): void {
  administration(event, "Initialized");
}
export function handlePaused(event: Paused): void {
  administration(event, "Paused");
}
export function handleUnpaused(event: Unpaused): void {
  administration(event, "Unpaused");
}
export function handleRewardRateUpdated(event: RewardRateUpdated): void {
  administration(event, "RewardRateUpdated");
}
export function handleTreasuryRatioUpdated(event: TreasuryRatioUpdated): void {
  administration(event, "TreasuryRatioUpdated");
}
export function handleMaxUnlockRequestsUpdated(
  event: MaxUnlockRequestsUpdated,
): void {
  administration(event, "MaxUnlockRequestsUpdated");
}
export function handleUnlockPeriodUpdated(event: UnlockPeriodUpdated): void {
  administration(event, "UnlockPeriodUpdated");
}
export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  administration(event, "OwnershipTransferred");
}
