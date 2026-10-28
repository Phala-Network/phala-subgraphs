import { ethereum } from "@graphprotocol/graph-ts";
import { closeDaysUpTo, refreshLatest } from "./days";

export function handleBlock(block: ethereum.Block): void {
  closeDaysUpTo(block);
  refreshLatest(block);
}
