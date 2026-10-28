import { BigInt, ethereum, Value } from "@graphprotocol/graph-ts";
import {
  ChainDay,
  ChainState,
  ClaimDay,
  Latest,
  VaultDay,
  VaultState,
} from "../generated/schema";
import {
  apr,
  assetsAt,
  circulationFields,
  copyFields,
  sharePrice,
} from "./assets";
import { CLAIM_FIELDS, date, DAY, FLOW_FIELDS } from "./constants";
import { chainState } from "./state";

// Must precede every mutation: events exactly at midnight belong to the new
// day's flows and cannot change the snapshot at that midnight.
export function closeDaysUpTo(block: ethereum.Block): void {
  const state = chainState();
  let boundary = state.nextDay;
  const vault = VaultState.load("current");
  while (boundary.le(block.timestamp)) {
    const day = new ChainDay(date(boundary));
    day.chain = state.chain;
    day.date = date(boundary);
    day.timestamp = boundary;
    day.observedBlockNumber = state.observedBlockNumber;
    day.observedBlockTimestamp = state.observedBlockTimestamp;
    circulationFields(state, day, boundary);
    day.save();
    if (vault != null) {
      const amounts = assetsAt(vault, boundary);
      const vd = new VaultDay(date(boundary));
      vd.date = date(boundary);
      vd.flowDate = date(boundary.minus(BigInt.fromI64(DAY)));
      vd.timestamp = boundary;
      vd.observedBlockNumber = state.observedBlockNumber;
      vd.observedBlockTimestamp = state.observedBlockTimestamp;
      vd.totalAssets = amounts.total;
      vd.treasuryAssets = amounts.treasury;
      vd.shareSupply = vault.shareSupply;
      vd.sharePrice = sharePrice(vault, amounts.total);
      vd.apr = apr(vault, amounts.total);
      vd.stakers = vault.stakers;
      vd.unstakeLocked = vault.unstakeLocked;
      vd.rewardRate = vault.rewardRate;
      vd.treasuryRatio = vault.treasuryRatio;
      vd.paused = vault.paused;
      vd.vaultImplementation = vault.implementation;
      vd.vaultImplementationReviewed = vault.vaultImplementationReviewed;
      vd.accrualMode = vault.accrualMode;
      copyFields(vault, vd, FLOW_FIELDS);
      vd.settlementTotalAssets = vault.settlementTotalAssets;
      vd.save();
      for (let i = 0; i < FLOW_FIELDS.length; i++)
        vault.set(FLOW_FIELDS[i], Value.fromBigInt(BigInt.zero()));
      vault.unset("settlementTotalAssets");
      vault.save();
    }
    if (state.claimsStarted) {
      const cd = new ClaimDay(date(boundary));
      cd.date = date(boundary);
      cd.flowDate = date(boundary.minus(BigInt.fromI64(DAY)));
      cd.timestamp = boundary;
      copyFields(state, cd, CLAIM_FIELDS);
      cd.save();
      for (let i = 0; i < CLAIM_FIELDS.length; i++)
        state.set(CLAIM_FIELDS[i], Value.fromBigInt(BigInt.zero()));
    }
    boundary = boundary.plus(BigInt.fromI64(DAY));
  }
  state.nextDay = boundary;
  state.save();
}

// Event handlers refresh after mutation; the Clock refreshes after all logs
// in its polled block. Block metadata is last observed, not a midnight lookup.
export function refreshLatest(block: ethereum.Block): void {
  const state = chainState();
  state.observedBlockNumber = block.number;
  state.observedBlockTimestamp = block.timestamp;
  state.save();
  const latest = new Latest("current");
  latest.chain = state.chain;
  latest.timestamp = block.timestamp;
  latest.observedBlockNumber = block.number;
  latest.observedBlockTimestamp = block.timestamp;
  circulationFields(state, latest, block.timestamp);
  const vault = VaultState.load("current");
  const amounts = assetsAt(vault, block.timestamp);
  latest.shareSupply = vault == null ? BigInt.zero() : vault.shareSupply;
  latest.sharePrice = sharePrice(vault, amounts.total);
  latest.apr = apr(vault, amounts.total);
  latest.stakers = vault == null ? BigInt.zero() : vault.stakers;
  latest.save();
}
