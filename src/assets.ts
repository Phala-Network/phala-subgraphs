import {
  BigDecimal,
  BigInt,
  Bytes,
  Entity,
  Value,
} from "@graphprotocol/graph-ts";
import { ChainState, VaultState } from "../generated/schema";
import { COMPONENTS, ZERO } from "./constants";

export class Assets {
  total: BigInt;
  treasury: BigInt;
  constructor(total: BigInt, treasury: BigInt) {
    this.total = total;
    this.treasury = treasury;
  }
}
export function markUnreviewed(state: VaultState): void {
  state.vaultImplementationReviewed = false;
  state.accrualMode = "checkpoint-only";
}
// Sourcify Vault._calculateRewards: treasuryRatio is basis points; round
// treasury down first, then give the remainder to shareholders.
export function assetsAt(state: VaultState | null, timestamp: BigInt): Assets {
  if (state == null) return new Assets(BigInt.zero(), BigInt.zero());
  if (
    state.vaultImplementationReviewed &&
    (state.checkpointTime.gt(timestamp) ||
      state.treasuryRatio.gt(BigInt.fromI32(10000)))
  ) {
    markUnreviewed(state);
    state.save();
  }
  let total = BigInt.zero();
  if (
    state.vaultImplementationReviewed &&
    !state.paused &&
    state.shareSupply.gt(BigInt.zero())
  ) {
    total = state.rewardRate.times(timestamp.minus(state.checkpointTime));
  }
  const treasury = total.times(state.treasuryRatio).div(BigInt.fromI32(10000));
  return new Assets(
    state.checkpointTotalAssets.plus(total).minus(treasury),
    state.checkpointTreasuryAssets.plus(treasury),
  );
}
export function sharePrice(
  state: VaultState | null,
  total: BigInt,
): BigDecimal {
  if (state == null || state.shareSupply.isZero()) return BigDecimal.zero();
  return total.toBigDecimal().div(state.shareSupply.toBigDecimal());
}
export function apr(state: VaultState | null, total: BigInt): BigDecimal {
  if (
    state == null ||
    !state.vaultImplementationReviewed ||
    state.paused ||
    state.shareSupply.isZero() ||
    total.isZero()
  )
    return BigDecimal.zero();
  return state.rewardRate
    .times(BigInt.fromI32(31536000))
    .toBigDecimal()
    .times(BigInt.fromI32(10000).minus(state.treasuryRatio).toBigDecimal())
    .div(BigDecimal.fromString("10000"))
    .div(total.toBigDecimal());
}
export function copyFields(
  source: Entity,
  target: Entity,
  fields: string[],
): void {
  for (let i = 0; i < fields.length; i++) {
    const value = source.get(fields[i]);
    assert(value != null, "Required state field missing");
    if (value != null) target.set(fields[i], value);
  }
}
export function circulationFields(
  state: ChainState,
  target: Entity,
  timestamp: BigInt,
): void {
  copyFields(state, target, COMPONENTS);
  const vault = VaultState.load("current");
  const assets = assetsAt(vault, timestamp);
  target.set(
    "vaultImplementation",
    Value.fromBytes(
      vault == null ? Bytes.fromHexString(ZERO) : vault.implementation,
    ),
  );
  target.set(
    "vaultImplementationReviewed",
    Value.fromBoolean(vault == null || vault.vaultImplementationReviewed),
  );
  target.set(
    "accrualMode",
    Value.fromString(vault == null ? "inactive" : vault.accrualMode),
  );
  const locked = vault == null ? BigInt.zero() : vault.unstakeLocked;
  // A negative vaultReward is valid when promised rewards exceed funding.
  const reward = state.vaultBalance
    .minus(assets.total)
    .minus(assets.treasury)
    .minus(locked);
  // Portal escrow backs circulating PHA on Base and remains in circulation.
  const circulation = state.totalSupply
    .minus(state.reward)
    .minus(state.sunsetReward)
    .minus(state.phalaChainBridge)
    .minus(state.khalaLegacyChainBridge)
    .minus(state.khalaChainBridge)
    .minus(state.sygmaBridge)
    .minus(reward);
  target.set("vaultTotalAssets", Value.fromBigInt(assets.total));
  target.set("vaultTreasuryAssets", Value.fromBigInt(assets.treasury));
  target.set("vaultUnstakeLocked", Value.fromBigInt(locked));
  target.set("vaultReward", Value.fromBigInt(reward));
  target.set("circulation", Value.fromBigInt(circulation));
}
