import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  DamageReport,
  EnvironmentReading,
  FeatureEvent,
  FeatureStateScope,
  GameTime,
  StateChange,
} from "./types.js";
import { DEFAULT_ENVIRONMENT_READING } from "./types.js";

interface EnvBucket {
  temperature: number[];
  illumination: number[];
  illuminationCaps: number[];
  oxygen: number[];
  noise: number[];
  hazardAdds: Set<string>;
  hazardRemoves: Set<string>;
}

function makeEnvBucket(): EnvBucket {
  return {
    temperature: [],
    illumination: [],
    illuminationCaps: [],
    oxygen: [],
    noise: [],
    hazardAdds: new Set(),
    hazardRemoves: new Set(),
  };
}

type ConnectionVote = { featureId: string; reason: string };

/**
 * Applier
 *
 * Single DGSM mutator: features never write to DGSM directly — they return
 * StateChange[] which the Applier consolidates and flushes in a two-pass
 * algorithm:
 *
 *   Pass 1: group order-independent kinds (hp/san/fatigue deltas,
 *           connection block votes, event emissions).
 *   Pass 2: (a) apply grouped aggregates (sum + clamp + DamageReport,
 *               refcount resolution for connection blocks);
 *           (b) replay the original change stream for order-dependent
 *               kinds (scene/character condition add/remove,
 *               feature scoped state set/remove).
 */
export class Applier {
  private connectionVotes = new Map<string, ConnectionVote[]>();

  constructor(
    private readonly dgsm: DynamicGameStateManager,
    private readonly featureScopes: ReadonlyMap<string, FeatureStateScope>
  ) {}

  flush(
    changes: readonly StateChange[],
    _tickTime: GameTime
  ): {
    damageReports: DamageReport[];
    featureEvents: FeatureEvent[];
    stateChanges: StateChange[];
  } {
    // Pass 1 — group order-independent kinds
    const hpBuckets = new Map<
      string,
      Array<{ featureId: string; delta: number; reason: string }>
    >();
    const sanBuckets = new Map<
      string,
      Array<{ featureId: string; delta: number; reason: string }>
    >();
    const fatigueBuckets = new Map<
      string,
      Array<{ featureId: string; delta: number; reason: string }>
    >();
    const setBlockVotes: Array<{
      connectionId: string;
      blocked: boolean;
      featureId: string;
      reason: string;
    }> = [];
    const featureEmissions: FeatureEvent[] = [];
    const envBuckets = new Map<string, EnvBucket>();
    const ensureEnvBucket = (locationId: string): EnvBucket => {
      let b = envBuckets.get(locationId);
      if (!b) {
        b = makeEnvBucket();
        envBuckets.set(locationId, b);
      }
      return b;
    };

    for (const c of changes) {
      switch (c.kind) {
        case "character.hp":
          this.bucketPush(hpBuckets, c.characterId, c);
          break;
        case "character.san":
          this.bucketPush(sanBuckets, c.characterId, c);
          break;
        case "character.fatigue":
          this.bucketPush(fatigueBuckets, c.characterId, c);
          break;
        case "connection.setBlock":
          setBlockVotes.push({
            connectionId: c.connectionId,
            blocked: c.blocked,
            featureId: c.sourceFeatureId,
            reason: c.reason,
          });
          break;
        case "event.emit":
          featureEmissions.push(c.event);
          break;
        case "environment.contribute": {
          const b = ensureEnvBucket(c.locationId);
          b[c.quantity].push(c.value);
          break;
        }
        case "environment.cap": {
          const b = ensureEnvBucket(c.locationId);
          b.illuminationCaps.push(c.value);
          break;
        }
        case "environment.hazard": {
          const b = ensureEnvBucket(c.locationId);
          if (c.add) {
            for (const h of c.add) b.hazardAdds.add(h);
          }
          if (c.remove) {
            for (const h of c.remove) b.hazardRemoves.add(h);
          }
          break;
        }
        default:
          break;
      }
    }

    // Pass 1.5 — environment aggregation
    // Aggregate per-location contributions into final EnvironmentReadings.
    // Only locations that received contributions this flush are written;
    // unvisited locations retain their last reading. Features re-contribute
    // each tick they care about a quantity.
    const TEMP_BASELINE = DEFAULT_ENVIRONMENT_READING.temperature;
    const ILLUM_BASELINE = DEFAULT_ENVIRONMENT_READING.illumination;
    const OXY_BASELINE = DEFAULT_ENVIRONMENT_READING.oxygen;
    const NOISE_BASELINE = DEFAULT_ENVIRONMENT_READING.noise;
    for (const [locationId, b] of envBuckets) {
      const temperature =
        TEMP_BASELINE + b.temperature.reduce((a, x) => a + x, 0);
      const illumPreCap = b.illumination.reduce(
        (m, x) => Math.max(m, x),
        ILLUM_BASELINE
      );
      const illumination = b.illuminationCaps.reduce(
        (m, x) => Math.min(m, x),
        illumPreCap
      );
      const oxygen = Math.max(
        0,
        Math.min(1, OXY_BASELINE + b.oxygen.reduce((a, x) => a + x, 0))
      );
      const noise = b.noise.reduce((m, x) => Math.max(m, x), NOISE_BASELINE);
      const airborneHazards = [...b.hazardAdds].filter(
        (h) => !b.hazardRemoves.has(h)
      );
      const reading: EnvironmentReading = {
        temperature,
        illumination,
        oxygen,
        noise,
        airborneHazards,
      };
      this.dgsm.setEnvironmentReading(locationId, reading);
    }

    // Pass 2 (a) — order-independent
    const damageReports: DamageReport[] = [];
    for (const [charId, contribs] of hpBuckets) {
      const r = this.applyDelta(charId, "hp", contribs);
      if (r) damageReports.push(r);
    }
    for (const [charId, contribs] of sanBuckets) {
      const r = this.applyDelta(charId, "san", contribs);
      if (r) damageReports.push(r);
    }
    for (const [charId, contribs] of fatigueBuckets) {
      const r = this.applyDelta(charId, "fatigue", contribs);
      if (r) damageReports.push(r);
    }
    for (const vote of setBlockVotes) {
      this.applySetBlockVote(vote);
    }

    // Pass 2 (b) — order-dependent; replay original changes
    for (const c of changes) {
      switch (c.kind) {
        case "scene.addCondition":
          this.dgsm.appendSceneCondition(c.sceneId, c.condition);
          break;
        case "scene.removeCondition":
          this.dgsm.removeSceneConditionsByFeatureId(
            c.sceneId,
            c.predicate.featureId
          );
          break;
        case "character.addCondition":
          this.dgsm.addCharacterCondition(c.characterId, c.condition);
          break;
        case "character.removeCondition":
          this.dgsm.removeCharacterCondition(c.characterId, c.conditionId);
          break;
        case "feature.setState": {
          const scope = this.featureScopes.get(c.featureId) ?? "scene";
          this.dgsm.setScopedFeatureState(c.featureId, scope, c.key, c.state);
          break;
        }
        case "feature.removeState": {
          const scope = this.featureScopes.get(c.featureId) ?? "scene";
          this.dgsm.removeScopedFeatureState(c.featureId, scope, c.key);
          break;
        }
        case "scene.damageItem": {
          this.dgsm.markItemDamaged(c.sceneId, c.itemId, c.damagedBy, c.reason);
          break;
        }
        case "character.position": {
          this.dgsm.setCharacterPosition(c.characterId, c.position);
          break;
        }
        default:
          break;
      }
    }

    const synthesizedDeaths: FeatureEvent[] = damageReports
      .filter((r) => r.died)
      .map((r) => ({ type: "character.died", characterId: r.characterId }));

    return {
      damageReports,
      featureEvents: [...featureEmissions, ...synthesizedDeaths],
      stateChanges: [...changes],
    };
  }

  private bucketPush<
    T extends {
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    },
  >(
    buckets: Map<
      string,
      Array<{ featureId: string; delta: number; reason: string }>
    >,
    id: string,
    c: T
  ): void {
    if (!buckets.has(id)) buckets.set(id, []);
    buckets
      .get(id)!
      .push({ featureId: c.sourceFeatureId, delta: c.delta, reason: c.reason });
  }

  private applyDelta(
    characterId: string,
    field: "hp" | "san" | "fatigue",
    contribs: Array<{ featureId: string; delta: number; reason: string }>
  ): DamageReport | null {
    const profile = this.dgsm.getNpcProfile(characterId);
    if (!profile) return null;
    const status = profile.status;
    const before = status[field] as number;
    const sum = contribs.reduce((acc, c) => acc + c.delta, 0);
    const max =
      field === "hp"
        ? status.maxHp
        : field === "san"
          ? status.maxSan
          : status.maxFatigue;
    const after = Math.max(0, Math.min(max, before + sum));
    this.dgsm.setCharacterField(characterId, field, after);
    const died = field === "hp" && before > 0 && after === 0;
    if (died) this.dgsm.markCharacterDead(characterId);
    return {
      characterId,
      field,
      contributors: contribs,
      finalValueAfter: after,
      died,
    };
  }

  private applySetBlockVote(vote: {
    connectionId: string;
    blocked: boolean;
    featureId: string;
    reason: string;
  }): void {
    if (!this.connectionVotes.has(vote.connectionId)) {
      this.connectionVotes.set(vote.connectionId, []);
    }
    const votes = this.connectionVotes.get(vote.connectionId)!;
    const existingIdx = votes.findIndex(
      (v) => v.featureId === vote.featureId && v.reason === vote.reason
    );
    if (vote.blocked) {
      if (existingIdx === -1) {
        votes.push({ featureId: vote.featureId, reason: vote.reason });
      }
    } else if (existingIdx !== -1) {
      votes.splice(existingIdx, 1);
    }
    this.dgsm.setConnectionBlocked(vote.connectionId, votes.length > 0);
  }

  /**
   * Serialize the refcount vote table so simulation snapshots survive
   * session restarts. Pairs with rehydrateConnectionVotes.
   */
  serializeConnectionVotes(): Record<string, ConnectionVote[]> {
    const out: Record<string, ConnectionVote[]> = {};
    for (const [k, v] of this.connectionVotes) out[k] = [...v];
    return out;
  }

  rehydrateConnectionVotes(data: Record<string, ConnectionVote[]>): void {
    this.connectionVotes = new Map(Object.entries(data));
  }
}
