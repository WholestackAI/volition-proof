/**
 * Append-only Volition command evidence ledger.
 *
 * Records `CommandReceipt` only. Not ShipGate. Never attests SHIP.
 * Same receiptId may be appended again only when the body matches.
 */
import type { CommandReceipt } from './command-receipt.js';

function receiptFingerprint(receipt: CommandReceipt): string {
  return JSON.stringify({
    receiptId: receipt.receiptId,
    actorId: receipt.actorId,
    action: receipt.action,
    argsHash: receipt.argsHash,
    contractHash: receipt.contractHash,
    mandateHash: receipt.mandateHash ?? null,
    decision: receipt.decision,
    executed: receipt.executed,
    effectHash: receipt.effectHash ?? null,
  });
}

export class CommandEvidenceLedger {
  private readonly byId = new Map<string, CommandReceipt>();
  private readonly order: string[] = [];

  append(receipt: CommandReceipt): CommandReceipt {
    const serialized = JSON.stringify(receipt);
    if (/\bSHIP\b/.test(serialized)) {
      throw new TypeError('command evidence ledger refuses ShipGate SHIP');
    }
    const existing = this.byId.get(receipt.receiptId);
    if (existing) {
      if (receiptFingerprint(existing) !== receiptFingerprint(receipt)) {
        throw new TypeError(
          `command receipt ${receipt.receiptId} already recorded with different content`,
        );
      }
      return existing;
    }
    this.byId.set(receipt.receiptId, receipt);
    this.order.push(receipt.receiptId);
    return receipt;
  }

  records(): readonly CommandReceipt[] {
    return this.order.map((id) => {
      const receipt = this.byId.get(id);
      if (!receipt) throw new Error(`command ledger missing ${id}`);
      return receipt;
    });
  }
}
