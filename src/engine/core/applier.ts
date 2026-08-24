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
/** Structural equality for plain feature-state objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
}

export class Applier {
  private connectionVotes = new Map<string, ConnectionVote[]>();

  constructor(
    private readonly dgsm: DynamicGameStateManager,
    private readonly featureScopes: ReadonlyMap<string, FeatureStateScope>
  ) {}

  /**
   * True when applying `c` provably cannot change anything.
   *
   * Subsystems emit defensively — the sun observer pushes a
   * `scene.removeCondition` on every tick "in case a stale [Lighting]
   * condition lingers" without checking whether one does, and stamina
   * re-writes an unchanged feature state every tick. Those land in the tick
   * record and in `lastUpdated` churn while meaning nothing.
   *
   * Only kinds whose no-op condition is unambiguous are covered. Records that
   * downstream consumers read (memory.*, relationship.change) and additive
   * kinds are never filtered, and neither are the delta kinds, which are
   * aggregated into DamageReports before being applied.
   */
  private isNoOp(c: StateChange): boolean {
    switch (c.kind) {
      case "scene.removeCondition":
        return !this.dgsm
          .getSceneConditions(c.sceneId)
          .some((cond) => cond.featureId === c.predicate.featureId);

      case "character.removeCondition": {
        const conditions =
          this.dgsm.getNpcProfile(c.characterId)?.status?.conditions ?? [];
        return !conditions.some((cond) => cond.id === c.conditionId);
      }

      case "feature.setState": {
        const scope = this.featureScopes.get(c.featureId) ?? "scene";
        const current = this.dgsm.getScopedFeatureState(
          c.featureId,
          scope,
          c.key
        );
        return current !== undefined && deepEqual(current, c.state);
      }

      default:
        return false;
    }
  }

  /**
   * For kinds that reference characters by id, verify the id actually names
   * a character. Returns the offending id, or null when the change is sound.
   *
   * The resolver's ids come from an LLM, and its schema examples used to
   * show invented placeholder ids — observed live as a `relationship.change`
   * from "npc_colleague", a character that does not exist, silently creating
   * a ghost node in the relationship graph (updateRelationship auto-creates
   * nodes for any string). The agent path validates its citations through
   * parseActionText; this is the same guard for the resolver/subsystem path.
   */
  private invalidCharacterRef(c: StateChange): string | null {
    const known = (id: string) =>
      this.dgsm.getNpcProfile(id) !== undefined ? null : id;
    switch (c.kind) {
      case "character.hp":
      case "character.san":
      case "character.fatigue":
      case "character.addCondition":
      case "character.removeCondition":
      case "character.position":
      case "memory.event":
      case "memory.witness":
        return known(c.characterId);
      case "relationship.change":
        return known(c.fromId) ?? known(c.toId);
      default:
        return null;
    }
  }

  flush(
    inputChanges: readonly StateChange[],
    _gameDateTime: GameTime
  ): {
    damageReports: DamageReport[];
    featureEvents: FeatureEvent[];
    stateChanges: StateChange[];
  } {
    // Filtered up front so no-ops are neither applied nor reported. Evaluated
    // against the pre-flush state, which is correct because a change that is
    // a no-op now can only be made non-no-op by another change in this same
    // batch — and the kinds covered here are not emitted twice per tick.
    const changes = inputChanges.filter((c) => {
      const badId = this.invalidCharacterRef(c);
      if (badId !== null) {
        console.warn(
          `[Applier] dropped ${c.kind}: unknown character id "${badId}"`
        );
        return false;
      }
      return !this.isNoOp(c);
    });

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
        // ── Resolver-emitted item ops ──
        case "item.modify": {
          this.dgsm.modifyItem(c.itemId, { description: c.description });
          break;
        }
        case "item.create": {
          this.dgsm.createItem(c.name, c.location, c.properties);
          break;
        }
        case "item.move": {
          this.dgsm.moveItem(c.itemId, c.from, c.to);
          break;
        }
        case "item.destroy": {
          this.dgsm.destroyItem(c.itemId);
          break;
        }
        // ── Resolver-emitted relationship op ──
        case "relationship.change": {
          this.dgsm.updateRelationship(
            c.fromId,
            c.toId,
            typeof c.delta === "number" ? c.delta : 0,
            typeof c.note === "string" ? c.note : ""
          );
          break;
        }
        // ── Memory entries: applier no-op; consumed by
        //    NpcActionController.routeResolverMemories after applier.flush. ──
        case "memory.event":
        case "memory.witness":
          break;
        default:
          break;
      }
    }

    const synthesizedDeaths: FeatureEvent[] = damageReports
      .filter((r) => r.died)
      .map((r) => ({
        type: "character.died",
        impact: 4,
        description: `${r.characterId} died`,
        characterId: r.characterId,
      }));

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
