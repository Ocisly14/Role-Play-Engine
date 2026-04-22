import type { EmergentScanner, ScannerContext } from "./emergentScanner.js";
import type { FeatureEvent } from "./types.js";

export class EmergentEventEmitter {
  private readonly scanners: EmergentScanner[] = [];

  constructor(scanners: EmergentScanner[] = []) {
    for (const s of scanners) this.register(s);
  }

  register(scanner: EmergentScanner): void {
    this.scanners.push(scanner);
  }

  scan(ctx: ScannerContext): { featureEvents: FeatureEvent[] } {
    const featureEvents: FeatureEvent[] = [];
    for (const s of this.scanners) {
      featureEvents.push(...s.scan(ctx));
    }
    return { featureEvents };
  }

  listScannerIds(): readonly string[] {
    return this.scanners.map((s) => s.id);
  }
}
