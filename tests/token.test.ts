import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  dataSourceMock,
  newMockEvent,
  test,
} from "matchstick-as";
import { Transfer } from "../generated/TokenFrom/Token";
import { handleFrom, handleTo } from "../src/token";
import { ZERO } from "../src/constants";

afterEach(() => {
  clearStore();
  dataSourceMock.resetValues();
});
function transfer(
  from: string,
  to: string,
  value: i32,
  log: i32,
  timestamp: i32 = 1588204801,
): Transfer {
  const event = changetype<Transfer>(newMockEvent());
  event.block.timestamp = BigInt.fromI32(timestamp);
  event.logIndex = BigInt.fromI32(log);
  event.parameters = [
    new ethereum.EventParam(
      "from",
      ethereum.Value.fromAddress(Address.fromString(from)),
    ),
    new ethereum.EventParam(
      "to",
      ethereum.Value.fromAddress(Address.fromString(to)),
    ),
    new ethereum.EventParam(
      "value",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(value)),
    ),
  ];
  return event;
}
const REWARD = "0x4731bc41b3cca4c2883b8ebb68cb546d5b3b4dd6";
const BRIDGE = "0xcd38b15a419491c7c1238b0659f65c755792e257";
test("S to S changes each side once, creates one audit Transfer, and preserves supply", () => {
  const mint = transfer(ZERO, REWARD, 100, 1);
  handleFrom(mint);
  handleTo(mint);
  const moved = transfer(REWARD, BRIDGE, 30, 2);
  handleFrom(moved);
  handleTo(moved);
  assert.entityCount("Transfer", 2);
  assert.fieldEquals("Latest", "current", "totalSupply", "100");
  assert.fieldEquals("Latest", "current", "reward", "70");
  assert.fieldEquals("Latest", "current", "phalaChainBridge", "30");
  assert.fieldEquals("Latest", "current", "circulation", "0");
  const burn = transfer(BRIDGE, ZERO, 10, 3);
  handleFrom(burn);
  handleTo(burn);
  assert.fieldEquals("Latest", "current", "totalSupply", "90");
  assert.fieldEquals("Latest", "current", "phalaChainBridge", "20");
});
test("a midnight transfer is excluded from that midnight's snapshot", () => {
  const mint = transfer(ZERO, REWARD, 100, 1);
  handleFrom(mint);
  handleTo(mint);
  const moved = transfer(REWARD, BRIDGE, 30, 2, 1588291200);
  handleFrom(moved);
  handleTo(moved);
  assert.fieldEquals("ChainDay", "2020-05-01", "reward", "100");
  assert.fieldEquals("Latest", "current", "reward", "70");
});

test("Base gap fills from deployment midnight even before its first transfer", () => {
  dataSourceMock.setNetwork("base");
  const mint = transfer(ZERO, REWARD, 100, 1, 1712448001);
  handleFrom(mint);
  handleTo(mint);
  assert.fieldEquals("ChainDay", "2024-04-05", "totalSupply", "0");
  assert.fieldEquals("ChainDay", "2024-04-06", "totalSupply", "0");
  assert.fieldEquals("ChainDay", "2024-04-07", "totalSupply", "0");
  assert.fieldEquals("Latest", "current", "chain", "base");
  assert.fieldEquals("Latest", "current", "circulation", "0");
});
