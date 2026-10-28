import { BigInt, Value } from "@graphprotocol/graph-ts";
import { Transfer as TokenTransfer } from "../generated/TokenFrom/Token";
import { Transfer } from "../generated/schema";
import { component, inS, ZERO } from "./constants";
import { closeDaysUpTo, refreshLatest } from "./days";
import { chainState } from "./state";

function apply(event: TokenTransfer, from: boolean): void {
  closeDaysUpTo(event.block);
  const state = chainState();
  const address = from ? event.params.from : event.params.to;
  const delta = from ? event.params.value.neg() : event.params.value;
  const field = component(address);
  if (field != "") {
    const balance = state.get(field);
    assert(balance != null, "Missing component");
    if (balance != null)
      state.set(field, Value.fromBigInt(balance.toBigInt().plus(delta)));
  }
  if (address.toHexString() == ZERO) {
    state.totalSupply = state.totalSupply.minus(delta);
  }
  state.save();
  // From always owns the audit row when both topics match. To owns it only
  // when From's topic does not match. Each handler changes just its own side.
  if (from || !inS(event.params.from)) {
    const transfer = new Transfer(
      event.transaction.hash.concatI32(event.logIndex.toI32()),
    );
    transfer.from = event.params.from;
    transfer.to = event.params.to;
    transfer.amount = event.params.value;
    transfer.blockNumber = event.block.number;
    transfer.timestamp = event.block.timestamp;
    transfer.transactionHash = event.transaction.hash;
    transfer.logIndex = event.logIndex;
    transfer.save();
  }
  refreshLatest(event.block);
}
export function handleFrom(event: TokenTransfer): void {
  apply(event, true);
}
export function handleTo(event: TokenTransfer): void {
  apply(event, false);
}
