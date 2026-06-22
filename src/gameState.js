import { INITIAL_STATE } from "./config.js";
import { createTile, ensureVisibleTiles } from "./map.js";
import { initializeAiFactions } from "./rules.js";

function createRuntimeSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

export function createInitialState(options = {}) {
  const seed = Number.isInteger(options.seed) ? options.seed >>> 0 : createRuntimeSeed();
  const origin = createTile({ q: 0, r: 0 }, 0, seed, true);
  const state = {
    ...INITIAL_STATE,
    seed,
    population: INITIAL_STATE.population,
    mutationPoints: 0,
    mutationAttributes: {
      power: 0,
      agility: 0,
      adaptation: 0
    },
    unlockedMutationIds: ["primitive"],
    aiFactions: [],
    tiles: new Map([[origin.key, origin]]),
    lastLoggedPopulation: INITIAL_STATE.population,
    recentTurnHistory: [],
    terrainEpoch: 0,
    visibleKeys: [],
    scoutedKeys: [],
    extraRevealedKeys: [],
    activeCoord: { q: 0, r: 0 },
    hasExpandedThisTurn: false,
    cycleExpansionCount: 0,
    cycleFreeExpansionUsed: false,
    pendingMutationChoice: false,
    mutationChoices: [],
    gameOver: false,
    result: null,
    log: ["252 Ma: 原始小型肉食恐龙在起源巢穴形成稳定种群。"]
  };

  return initializeAiFactions(ensureVisibleTiles(state));
}
