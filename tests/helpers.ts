import {
  Address,
  BigInt,
  Bytes,
  ethereum,
  Value,
} from "@graphprotocol/graph-ts";
import { createMockedFunction, newMockEvent } from "matchstick-as";
import { VaultState } from "../generated/schema";
import { FLOW_FIELDS, IMPLEMENTATION, VAULT } from "../src/constants";

export function block(timestamp: i64, number: i32 = 100): ethereum.Block {
  const b = newMockEvent().block;
  b.timestamp = BigInt.fromI64(timestamp);
  b.number = BigInt.fromI32(number);
  return b;
}
export function vaultState(): VaultState {
  const state = new VaultState("current");
  state.implementation = Bytes.fromHexString(IMPLEMENTATION);
  state.vaultImplementationReviewed = true;
  state.accrualMode = "formula";
  state.checkpointTime = BigInt.fromI32(1588204800);
  state.checkpointTotalAssets = BigInt.fromI32(1000);
  state.checkpointTreasuryAssets = BigInt.fromI32(20);
  state.rewardRate = BigInt.fromI32(7);
  state.treasuryRatio = BigInt.fromI32(3333);
  state.paused = false;
  state.shareSupply = BigInt.fromI32(100);
  state.stakers = BigInt.fromI32(1);
  state.unstakeLocked = BigInt.zero();
  for (let i = 0; i < FLOW_FIELDS.length; i++)
    state.set(FLOW_FIELDS[i], Value.fromBigInt(BigInt.zero()));
  return state;
}
export function mockVault(
  checkpoint: i32 = 1588204800,
  total: i32 = 1000,
  treasury: i32 = 20,
  rate: i32 = 7,
  ratio: i32 = 3333,
  supply: i32 = 100,
  paused: boolean = false,
): void {
  const names = [
    "checkpointTime",
    "checkpointTotalAssets",
    "checkpointTreasuryAssets",
    "rewardRate",
    "treasuryRatio",
    "totalSupply",
  ];
  const values = [checkpoint, total, treasury, rate, ratio, supply];
  for (let i = 0; i < names.length; i++) {
    createMockedFunction(
      Address.fromString(VAULT),
      names[i],
      names[i] + "():(uint256)",
    ).returns([ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(values[i]))]);
  }
  createMockedFunction(
    Address.fromString(VAULT),
    "paused",
    "paused():(bool)",
  ).returns([ethereum.Value.fromBoolean(paused)]);
}
