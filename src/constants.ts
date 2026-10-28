import { Address, BigInt } from "@graphprotocol/graph-ts";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const VAULT = "0x21d6ec8fc14caacc55afa23cba66798dab3a0ec0";
export const IMPLEMENTATION = "0xc0b39989381d8c88b7ef82a80d4c90540e70862a";
export const DAY: i64 = 86400;
export const COMPONENTS = [
  "totalSupply",
  "reward",
  "sunsetReward",
  "phalaChainBridge",
  "khalaLegacyChainBridge",
  "khalaChainBridge",
  "sygmaBridge",
  "portalBridge",
  "vaultBalance",
];
export const FLOW_FIELDS = [
  "dailyRewards",
  "dailyTreasuryRewards",
  "deposits",
  "withdrawRequests",
  "claims",
  "treasuryClaims",
  "depositCount",
  "withdrawRequestCount",
  "claimCount",
  "treasurySettlementCount",
];
export const CLAIM_FIELDS = [
  "khalaClaimCount",
  "khalaFree",
  "khalaStaked",
  "phalaClaimCount",
  "phalaFree",
  "phalaStaked",
];
export function component(address: Address): string {
  const hex = address.toHexString();
  if (hex == "0x4731bc41b3cca4c2883b8ebb68cb546d5b3b4dd6") return "reward";
  if (hex == "0xcd38b15a419491c7c1238b0659f65c755792e257")
    return "phalaChainBridge";
  if (hex == "0x6ed3bc069cf4f87de05c04c352e8356492ec6efe")
    return "khalaLegacyChainBridge";
  if (hex == "0xeec0fb4913119567cdfc0c5fc2bf8f9f9b226c2d")
    return "khalaChainBridge";
  if (hex == "0xc832588193cd5ed2185dada4a531e0b26ec5b830") return "sygmaBridge";
  if (hex == "0x3ee18b2214aff97000d974cf647e7c347e8fa585")
    return "portalBridge";
  if (hex == "0x4a396b5c9a6fbc1bc0525f24ac0a246766f3ebef")
    return "sunsetReward";
  if (hex == VAULT) return "vaultBalance";
  return "";
}
export function inS(address: Address): boolean {
  return address.toHexString() == ZERO || component(address) != "";
}
export function date(timestamp: BigInt): string {
  return new Date(timestamp.toI64() * 1000).toISOString().slice(0, 10);
}
