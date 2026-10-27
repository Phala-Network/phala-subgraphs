import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  newMockEvent,
  test,
} from "matchstick-as";
import { Claimed } from "../generated/KhalaClaimer/KhalaClaimer";
import { ClaimedAndBridged } from "../generated/PhalaClaimer/PhalaClaimer";
import { handleKhalaClaimer, handlePhalaClaimer } from "../src/claimer";
import { handleBlock } from "../src/clock";
import { block } from "./helpers";

afterEach(() => clearStore());
test("legacy no-code IDs, field types and metadata survive the merged claimer mapping", () => {
  const e = changetype<Claimed>(newMockEvent());
  e.address = Address.fromString("0xa139f849000c5438855032ebfeed9ee104023a73");
  e.logIndex = BigInt.fromI32(407);
  e.block.timestamp = BigInt.fromI32(1588204801);
  const user = Address.fromString("0x0000000000000000000000000000000000000001");
  e.parameters = [
    new ethereum.EventParam("user", ethereum.Value.fromAddress(user)),
    new ethereum.EventParam(
      "free",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(12)),
    ),
    new ethereum.EventParam(
      "staked",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(34)),
    ),
    new ethereum.EventParam("receiver", ethereum.Value.fromAddress(user)),
  ];
  handleKhalaClaimer(e);
  const id = e.transaction.hash.toHexString() + "-407";
  assert.fieldEquals("Claimed", id, "user", user.toHexString());
  assert.fieldEquals("Claimed", id, "contractId_", e.address.toHexString());
  assert.fieldEquals(
    "Claimed",
    id,
    "transactionHash_",
    e.transaction.hash.toHexString(),
  );
  assert.fieldEquals("Claimed", id, "timestamp_", "1588204801");
  assert.fieldEquals("Claimed", id, "free", "12");
  const phala = changetype<ClaimedAndBridged>(newMockEvent());
  phala.block.timestamp = e.block.timestamp;
  phala.address = Address.fromString(
    "0x8b6d7ab0be8d1f6ae40738c4cff75134110a777f",
  );
  phala.parameters = [
    e.parameters[0],
    e.parameters[1],
    e.parameters[2],
    new ethereum.EventParam("l1Receiver", ethereum.Value.fromAddress(user)),
    new ethereum.EventParam("l2Receiver", ethereum.Value.fromAddress(user)),
  ];
  handlePhalaClaimer(phala);
  assert.entityCount("Claimed", 1);
  assert.entityCount("ClaimedAndBridged", 1);
  assert.fieldEquals(
    "ClaimedAndBridged",
    phala.transaction.hash.toHexString() + "-" + phala.logIndex.toString(),
    "l2Receiver",
    user.toHexString(),
  );
  handleBlock(block(1588291200));
  assert.fieldEquals("ClaimDay", "2020-05-01", "khalaFree", "12");
  assert.fieldEquals("ClaimDay", "2020-05-01", "phalaStaked", "34");
});
