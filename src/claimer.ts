import { BigInt, ethereum, Value } from "@graphprotocol/graph-ts";
import { Claimed as KhalaClaim } from "../generated/KhalaClaimer/KhalaClaimer";
import { ClaimedAndBridged as PhalaClaim } from "../generated/PhalaClaimer/PhalaClaimer";
import { Claimed, ClaimedAndBridged } from "../generated/schema";
import { closeDaysUpTo, refreshLatest } from "./days";
import { chainState } from "./state";

function addClaim(
  event: ethereum.Event,
  chain: string,
  free: BigInt,
  staked: BigInt,
): void {
  const state = chainState();
  state.claimsStarted = true;
  const fields = [chain + "ClaimCount", chain + "Free", chain + "Staked"];
  const amounts = [BigInt.fromI32(1), free, staked];
  for (let i = 0; i < fields.length; i++) {
    const previous = state.get(fields[i]);
    assert(previous != null, "Missing claim counter");
    if (previous != null)
      state.set(
        fields[i],
        Value.fromBigInt(previous.toBigInt().plus(amounts[i])),
      );
  }
  state.save();
  refreshLatest(event.block);
}
export function handleKhalaClaimer(event: KhalaClaim): void {
  closeDaysUpTo(event.block);
  const claim = new Claimed(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  claim.block_number = event.block.number;
  claim.timestamp_ = event.block.timestamp;
  claim.transactionHash_ = event.transaction.hash.toHexString();
  claim.contractId_ = event.address.toHexString();
  claim.user = event.params.user.toHexString();
  claim.free = event.params.free;
  claim.staked = event.params.staked;
  claim.receiver = event.params.receiver.toHexString();
  claim.save();
  addClaim(event, "khala", event.params.free, event.params.staked);
}
export function handlePhalaClaimer(event: PhalaClaim): void {
  closeDaysUpTo(event.block);
  const claim = new ClaimedAndBridged(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  claim.block_number = event.block.number;
  claim.timestamp_ = event.block.timestamp;
  claim.transactionHash_ = event.transaction.hash.toHexString();
  claim.contractId_ = event.address.toHexString();
  claim.user = event.params.user.toHexString();
  claim.free = event.params.free;
  claim.staked = event.params.staked;
  claim.l1Receiver = event.params.l1Receiver.toHexString();
  claim.l2Receiver = event.params.l2Receiver.toHexString();
  claim.save();
  addClaim(event, "phala", event.params.free, event.params.staked);
}
