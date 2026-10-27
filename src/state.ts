import { BigInt, dataSource, Value } from "@graphprotocol/graph-ts";
import { ChainState } from "../generated/schema";
import { CLAIM_FIELDS, COMPONENTS } from "./constants";

export function chainState(): ChainState {
  let state = ChainState.load("current");
  if (state != null) return state;
  state = new ChainState("current");
  state.chain = dataSource.network() == "base" ? "base" : "ethereum";
  // The deployment date's midnight is the initial, zero-supply snapshot.
  state.nextDay = BigInt.fromI64(
    state.chain == "base" ? 1712275200 : 1588204800,
  );
  state.observedBlockNumber = BigInt.zero();
  state.observedBlockTimestamp = BigInt.zero();
  state.claimsStarted = false;
  for (let i = 0; i < COMPONENTS.length; i++)
    state.set(COMPONENTS[i], Value.fromBigInt(BigInt.zero()));
  for (let i = 0; i < CLAIM_FIELDS.length; i++)
    state.set(CLAIM_FIELDS[i], Value.fromBigInt(BigInt.zero()));
  state.save();
  return state;
}
