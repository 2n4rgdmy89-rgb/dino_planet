import { END_MA, MAX_TURNS, TERRAIN_TYPES, VICTORY } from "./config.js";
import {
  EVOLUTION_NODES,
  MUTATION_ATTRIBUTES,
  getAdvancedMutationNodes,
  getMutationAttribute,
  getMutationRarity,
  getSpeciesNode
} from "./evolution.js";
import { TERRAIN_WEIGHTS } from "./config.js";
import {
  coordKey,
  coordinateSeed,
  createTile,
  ensureVisibleTiles,
  getCombatRequirementPressure,
  getNeighbors,
  getPopulationCostPressure,
  generateTileCombatRequirement,
  generateTilePopulationCost,
  mulberry32,
  revealSecondRingTiles,
  resetPlayerRevealedTiles,
  weightedTerrain
} from "./map.js";
import { applyRandomEvent } from "./randomEvents.js";

// 规则模块是纯状态转换层：输入当前 state 和玩家动作，返回新的 state。
// 它不直接操作 DOM，因此同一套规则可以被 UI、测试和未来存档/回放系统复用。

// 两次历史大灭绝发生在跨过对应 Ma 边界之后。
const MASS_EXTINCTIONS = [
  { boundaryMa: 201, label: "三叠纪末期" },
  { boundaryMa: 145, label: "侏罗纪末期" }
];
const MASS_EXTINCTION_MAX_SURVIVOR_TILES = 10;

// AI 族群的生成与成长参数。
// 初始 AI 负责开局压力；定期刷新的 AI 随波次提高人口和基础战力。
const AI_SPAWN_INTERVAL = 20;
const AI_SPAWN_MAX_ATTEMPTS = 3;
const INITIAL_AI_FACTION_COUNT = 2;
const INITIAL_AI_SPAWN_RADIUS = 5;
const AI_BOUNDARY_SPAWN_MIN_RADIUS = 3;
const AI_BOUNDARY_SPAWN_MAX_RADIUS = 6;
const AI_BOUNDARY_SPAWN_RETRY_RADIUS_STEP = 1;
const AI_INITIAL_POPULATION = 16;
const AI_SCHEDULED_POPULATION_STEP = 28;
const AI_SCHEDULED_POWER_SCALE = 2;
const AI_JURASSIC_POWER_MULTIPLIER = 1.5;
const AI_CRETACEOUS_POWER_MULTIPLIER = 2;
const AI_JURASSIC_POPULATION_MULTIPLIER = 2;
const AI_CRETACEOUS_POPULATION_MULTIPLIER = 3;
const AI_ERA_JURASSIC_POWER_MULTIPLIER = 1.1;
const AI_ERA_CRETACEOUS_POWER_MULTIPLIER = 1.2;
const AI_ERA_JURASSIC_GROWTH_MULTIPLIER = 1.5;
const AI_ERA_CRETACEOUS_GROWTH_MULTIPLIER = 1.5;
const AI_SCHEDULED_TILE_SCALE = 4;
const AI_INITIAL_GROWTH_RATE = 1;
const ATTACKER_POPULATION_LOSS_MULTIPLIER = 1.5;
const DEFENDER_POPULATION_LOSS_MULTIPLIER = 0.75;
const CONQUERABLE_TERRAIN_WEIGHTS = TERRAIN_WEIGHTS.filter(([terrainId]) => TERRAIN_TYPES[terrainId].conquerable);
const RARE_SLOT_UNLOCK_TURN = 20;
const SECOND_ADVANCED_SLOT_UNLOCK_TURN = 40;
const UNCOMMON_ATTRIBUTE_THRESHOLD = 3;
const UNCOMMON_MUTATION_CHANCE = 0.2;

export function getOwnedTiles(state) {
  // 玩家拥有的格子是人口增长、战力加成、可见边界和失败判定的基础。
  return [...state.tiles.values()].filter((tile) => tile.owned);
}

function getAiTiles(state, factionId) {
  return [...state.tiles.values()].filter((tile) => tile.aiFactionId === factionId);
}

function removeExtinctAiFactions(state) {
  // 收集每个派系实际拥有的 tile 数量，用于识别"有人口无领地"的幽灵派系。
  const factionTileCount = new Map();
  for (const tile of state.tiles.values()) {
    if (tile.aiFactionId != null) {
      factionTileCount.set(tile.aiFactionId, (factionTileCount.get(tile.aiFactionId) ?? 0) + 1);
    }
  }
  const extinctFactionIds = new Set(
    (state.aiFactions ?? [])
      .filter((faction) =>
        Math.floor(faction.population ?? AI_INITIAL_POPULATION) <= 0 ||
        (factionTileCount.get(faction.id) ?? 0) === 0
      )
      .map((faction) => faction.id)
  );
  if (extinctFactionIds.size === 0) return state;

  const nextTiles = new Map(state.tiles);
  for (const [key, tile] of nextTiles) {
    if (extinctFactionIds.has(tile.aiFactionId)) {
      nextTiles.set(key, {
        ...tile,
        aiFactionId: null,
        revealed: false,
        scouted: false
      });
    }
  }

  const survivingFactions = (state.aiFactions ?? []).filter((faction) => !extinctFactionIds.has(faction.id));
  const extinctMessages = [...extinctFactionIds]
    .sort((left, right) => left - right)
    .map((factionId) => `敌群 #${factionId} 人口归零，族群消亡。`);

  return appendLog(
    {
      ...state,
      tiles: nextTiles,
      aiFactions: survivingFactions
    },
    `${state.currentMa} Ma：${extinctMessages.join(" ")}`
  );
}

function getAiTerrainCount(state, factionId, terrainId) {
  return getAiTiles(state, factionId).filter((tile) => tile.terrain === terrainId).length;
}

function getAiDensityCaptureCost(state, faction) {
  // AI 攻占玩家格子时，玩家损失取决于敌群“人口密度”。
  // 敌群人口越集中，攻占造成的损失越高。
  return getAiDensityCaptureSummary(state, faction).cost;
}

function getAttackerPopulationLoss(baseLoss) {
  return Math.ceil(baseLoss * ATTACKER_POPULATION_LOSS_MULTIPLIER);
}

function getDefenderPopulationLoss(baseLoss) {
  return Math.round(baseLoss * DEFENDER_POPULATION_LOSS_MULTIPLIER);
}

function getAiDensityCaptureSummary(state, faction) {
  if (!faction) {
    return {
      population: 0,
      tileCount: 1,
      averagePopulation: 0,
      multiplier: 2,
      cost: 0
    };
  }
  const aiTileCount = Math.max(1, getAiTiles(state, faction.id).length);
  const population = faction.population ?? AI_INITIAL_POPULATION;
  const averagePopulation = population / aiTileCount;
  return {
    population,
    tileCount: aiTileCount,
    averagePopulation,
    multiplier: 2,
    cost: Math.ceil(averagePopulation * 2)
  };
}

function formatAiPopulationFormula(summary) {
  const multiplier = summary.multiplier === 1 ? "" : ` × ${summary.multiplier}`;
  return `敌群 ${summary.population} 人 / ${summary.tileCount} 格${multiplier}，向上取整`;
}

function getPlayerDensityBattleSummary(state) {
  const tileCount = Math.max(1, getOwnedTiles(state).length);
  const population = Math.max(0, Math.floor(state.population ?? 0));
  const averagePopulation = population / tileCount;
  return {
    population,
    tileCount,
    averagePopulation,
    multiplier: 2,
    cost: Math.ceil(averagePopulation * 2)
  };
}

function formatPlayerPopulationFormula(summary) {
  return `玩家 ${summary.population} 人 / ${summary.tileCount} 格 × ${summary.multiplier}，向上取整`;
}

function growAiFaction(state, faction) {
  // AI 每回合有基础增长，湿地按 growthRate 追加增长。
  const population = faction.population ?? AI_INITIAL_POPULATION;
  const grasslandCount = getAiTerrainCount(state, faction.id, "grassland");
  const growthRate = faction.growthRate ?? AI_INITIAL_GROWTH_RATE;
  const effectiveGrowthRate = Math.ceil(growthRate * getAiEraGrowthMultiplier(state.currentMa));
  const growth = Math.floor(2 + grasslandCount * effectiveGrowthRate);
  return {
    ...faction,
    growthRate,
    population: population + growth
  };
}

function growAiFactions(state) {
  const nextFactions = (state.aiFactions ?? []).map((faction) =>
    faction.spawnTurn >= state.turn ? faction : growAiFaction(state, faction)
  );
  const growthSummaries = nextFactions
    .map((faction) => {
      const before = getAiFactionById(state, faction.id);
      const beforePopulation = before?.population ?? AI_INITIAL_POPULATION;
      const growth = (faction.population ?? AI_INITIAL_POPULATION) - beforePopulation;
      return growth > 0 ? `#${faction.id} +${growth}` : null;
    })
    .filter(Boolean);
  const nextState = {
    ...state,
    aiFactions: nextFactions
  };

  return growthSummaries.length > 0
    ? appendLog(nextState, `${state.currentMa} Ma：敌群人口增长（${growthSummaries.join("，")}）。`)
    : nextState;
}

function getAiAveragePopulationByFaction(state) {
  return new Map(
    (state.aiFactions ?? []).map((faction) => {
      const aiTileCount = Math.max(1, getAiTiles(state, faction.id).length);
      return [faction.id, (faction.population ?? AI_INITIAL_POPULATION) / aiTileCount];
    })
  );
}

function advanceAiCycleGrowth(state) {
  // 每 5Ma 周期，已激活的 AI 会在“繁殖成长”和“战力成长”中随机强化一项。
  // cycleForestPower 是周期临时值，进入新周期时重置。
  if (state.turn <= 0 || state.turn % 5 !== 0) return state;
  const growthSummaries = [];
  const nextFactions = (state.aiFactions ?? []).map((faction) => {
    if (faction.spawnTurn >= state.turn) {
      return {
        ...faction,
        cycleForestPower: 0
      };
    }

    const growsReproduction = stableRandom(state, faction.id * 2000 + 5)() < 0.5;
    growthSummaries.push(`#${faction.id} ${growsReproduction ? "繁殖 +1" : "战力 +1"}`);
    return {
      ...faction,
      growthRate: (faction.growthRate ?? AI_INITIAL_GROWTH_RATE) + (growsReproduction ? 1 : 0),
      growthPower: (faction.growthPower ?? 0) + (growsReproduction ? 0 : 1),
      cycleForestPower: 0
    };
  });
  const nextState = {
    ...state,
    aiFactions: nextFactions
  };

  return growthSummaries.length > 0
    ? appendLog(nextState, `${state.currentMa} Ma：敌群周期成长（${growthSummaries.join("，")}）。`)
    : nextState;
}

export function getAiFactionPower(state, faction) {
  // AI 总战力 = 基础战力 + 沙漠永久加成 + 周期成长战力 + 本周期森林临时战力。
  if (!faction) return 0;
  const desertCount = getAiTerrainCount(state, faction.id, "desert");
  const rawPower = (faction.basePower ?? 1) + desertCount + (faction.growthPower ?? 0) + (faction.cycleForestPower ?? 0);
  return Math.ceil(rawPower * getAiEraPowerMultiplier(state.currentMa));
}

export function getAiFactionById(state, factionId) {
  return (state.aiFactions ?? []).find((faction) => faction.id === factionId) ?? null;
}

export function getTileAiPower(state, tile) {
  return getAiFactionPower(state, getAiFactionById(state, tile?.aiFactionId));
}

export function isTileThreatenedByAi(state, tile) {
  // 只要玩家领地相邻任意 AI 格子，就在 UI 上标记为受威胁。
  if (!tile?.owned) return false;
  return getNeighbors(tile).some((neighbor) => state.tiles.get(coordKey(neighbor))?.aiFactionId);
}

function axialDistance(coord) {
  return (Math.abs(coord.q) + Math.abs(coord.r) + Math.abs(coord.q + coord.r)) / 2;
}

function hexDistance(left, right) {
  return axialDistance({ q: left.q - right.q, r: left.r - right.r });
}

function generateRingCandidates(minRadius, maxRadius) {
  // 生成指定半径环带内的坐标，用于把 AI 刷在玩家领地外侧。
  const candidates = [];
  for (let q = -maxRadius; q <= maxRadius; q += 1) {
    for (let r = -maxRadius; r <= maxRadius; r += 1) {
      const coord = { q, r };
      const distance = axialDistance(coord);
      if (distance >= minRadius && distance <= maxRadius) {
        candidates.push(coord);
      }
    }
  }
  return candidates;
}

function generatePlayerBoundaryKeys(state) {
  const ownedKeys = new Set(getOwnedTiles(state).map((tile) => tile.key));
  const boundaryKeys = new Set();

  for (const ownedTile of getOwnedTiles(state)) {
    for (const neighbor of getNeighbors(ownedTile)) {
      const key = coordKey(neighbor);
      if (!ownedKeys.has(key)) {
        boundaryKeys.add(key);
      }
    }
  }

  return boundaryKeys;
}

function generatePlayerBoundaryCandidates(state, minRadius, maxRadius) {
  const candidatesByKey = new Map();
  const boundaryCoords = [...generatePlayerBoundaryKeys(state)].map((key) => {
    const [q, r] = key.split(",").map(Number);
    return { q, r };
  });

  for (const boundary of boundaryCoords) {
    for (let q = boundary.q - maxRadius; q <= boundary.q + maxRadius; q += 1) {
      for (let r = boundary.r - maxRadius; r <= boundary.r + maxRadius; r += 1) {
        const coord = { q, r };
        const distance = hexDistance(coord, boundary);
        const nearestBoundaryDistance = Math.min(...boundaryCoords.map((candidate) => hexDistance(coord, candidate)));
        if (distance >= minRadius && distance <= maxRadius && nearestBoundaryDistance >= minRadius) {
          candidatesByKey.set(coordKey(coord), coord);
        }
      }
    }
  }

  return [...candidatesByKey.values()].sort((left, right) => coordKey(left).localeCompare(coordKey(right)));
}

function shuffled(list, random) {
  // 稳定洗牌：由调用方提供确定性 random，保证测试和回放可复现。
  const next = [...list];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function stableRandom(state, salt) {
  // 所有 AI 决策都用 state.seed + turn + salt 派生随机源。
  // salt 区分刷怪、攻击、扩张等场景，避免不同决策互相影响。
  return mulberry32((state.seed ^ Math.imul(state.turn + 1, 1597334677) ^ Math.imul(salt + 17, 2654435761)) >>> 0);
}

function getNextAiFactionId(state) {
  return Math.max(0, ...(state.aiFactions ?? []).map((faction) => faction.id)) + 1;
}

function getScheduledAiPowerMultiplier(currentMa) {
  if (currentMa < 145) return AI_CRETACEOUS_POWER_MULTIPLIER;
  if (currentMa < 201) return AI_JURASSIC_POWER_MULTIPLIER;
  return 1;
}

function getScheduledAiPopulationMultiplier(currentMa) {
  if (currentMa < 145) return AI_CRETACEOUS_POPULATION_MULTIPLIER;
  if (currentMa < 201) return AI_JURASSIC_POPULATION_MULTIPLIER;
  return 1;
}

function getAiEraPowerMultiplier(currentMa) {
  if (currentMa < 145) return AI_ERA_CRETACEOUS_POWER_MULTIPLIER;
  if (currentMa < 201) return AI_ERA_JURASSIC_POWER_MULTIPLIER;
  return 1;
}

function getAiEraGrowthMultiplier(currentMa) {
  if (currentMa < 145) return AI_ERA_CRETACEOUS_GROWTH_MULTIPLIER;
  if (currentMa < 201) return AI_ERA_JURASSIC_GROWTH_MULTIPLIER;
  return 1;
}

function isOpenAiTile(tile) {
  return tile?.conquerable !== false && !tile.owned && !tile.aiFactionId;
}

function warningDirectionFor(coord) {
  // 将 axial 坐标近似投影到二维平面，再换算成六方向警告文案。
  const x = coord.q + coord.r / 2;
  const y = coord.r * 0.8660254038;
  const angle = Math.atan2(y, x);
  const sector = (Math.round(angle / (Math.PI / 3)) + 6) % 6;
  return ["东", "东南", "西南", "西", "西北", "东北"][sector];
}

function collectAiSpawnTiles(state, originTile, factionId, tileCount, random) {
  const targetTileCount = Math.max(1, Math.floor(tileCount ?? 1));
  const nextTiles = new Map(state.tiles);
  const spawnedOrigin = {
    ...originTile,
    owned: false,
    aiFactionId: factionId,
    revealed: false,
    scouted: false
  };
  const selectedKeys = new Set([spawnedOrigin.key]);
  let selectedTileCount = 1;
  const queue = [spawnedOrigin];

  nextTiles.set(spawnedOrigin.key, spawnedOrigin);

  for (let queueIndex = 0; queueIndex < queue.length && selectedTileCount < targetTileCount; queueIndex += 1) {
    const neighbors = shuffled(getNeighbors(queue[queueIndex]), random);
    for (const neighbor of neighbors) {
      if (selectedTileCount >= targetTileCount) break;

      const key = coordKey(neighbor);
      if (selectedKeys.has(key)) continue;

      const existingTile = nextTiles.get(key);
      const candidateTile = existingTile ?? createTile(neighbor, state.turn, state.seed, false, state.terrainEpoch ?? 0);
      if (!isOpenAiTile(candidateTile)) continue;

      const spawnedTile = {
        ...candidateTile,
        owned: false,
        aiFactionId: factionId,
        revealed: false,
        scouted: false
      };
      nextTiles.set(key, spawnedTile);
      selectedKeys.add(key);
      selectedTileCount += 1;
      queue.push(spawnedTile);
    }
  }

  return nextTiles;
}

function spawnAiFaction(state, options) {
  // 在指定环带中寻找第一个可用格子作为 AI 起点。
  // 若当前环带失败，会按 maxAttempts 逐步向外扩张搜索半径。
  const factionId = options.factionId ?? getNextAiFactionId(state);
  const retryRadiusStep = options.retryRadiusStep ?? 2;

  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    const minRadius = options.minRadius + attempt * retryRadiusStep;
    const maxRadius = options.maxRadius + attempt * retryRadiusStep;
    const random = stableRandom(state, options.salt + attempt);
    const candidates = shuffled(
      options.spawnFromPlayerBoundary
        ? generatePlayerBoundaryCandidates(state, minRadius, maxRadius)
        : generateRingCandidates(minRadius, maxRadius),
      random
    );

    for (const coord of candidates) {
      const key = coordKey(coord);
      const existingTile = state.tiles.get(key);
      const candidateTile = existingTile ?? createTile(coord, state.turn, state.seed, false, state.terrainEpoch ?? 0);
      if (!isOpenAiTile(candidateTile)) continue;

      const nextTiles = collectAiSpawnTiles(state, candidateTile, factionId, options.tileCount, random);

      return appendLog(
        {
          ...state,
          tiles: nextTiles,
          aiFactions: [
            ...(state.aiFactions ?? []),
            {
              id: factionId,
              waveIndex: options.waveIndex,
              spawnTurn: options.spawnTurn,
              originKey: key,
              warningDirection: warningDirectionFor(coord),
              initial: Boolean(options.initial),
              population: options.population,
              basePower: options.basePower,
              growthRate: options.growthRate,
              growthPower: options.growthPower ?? 0,
              cycleForestPower: options.cycleForestPower ?? 0
            }
          ]
        },
        `${state.currentMa} Ma：敌对族群活动迹象来自${warningDirectionFor(coord)}方向。`
      );
    }
  }

  return state;
}

export function initializeAiFactions(state) {
  // 开局直接生成两个隐藏敌群，给玩家后续探索和边界压力埋下威胁。
  let nextState = state;
  for (let index = 0; index < INITIAL_AI_FACTION_COUNT; index += 1) {
    nextState = spawnAiFaction(nextState, {
      factionId: index + 1,
      waveIndex: 0,
      spawnTurn: 0,
      minRadius: INITIAL_AI_SPAWN_RADIUS,
      maxRadius: INITIAL_AI_SPAWN_RADIUS,
      maxAttempts: 1,
      salt: 5000 + index * 97,
      initial: true,
      population: AI_INITIAL_POPULATION,
      basePower: 1,
      growthRate: AI_INITIAL_GROWTH_RATE,
      growthPower: 0,
      cycleForestPower: 0,
      tileCount: 1
    });
  }
  return nextState;
}

function spawnAiFactionIfNeeded(state) {
  // 除开局敌群外，每隔固定回合生成一个更强的计划波次。
  if (state.turn <= 0 || state.turn % AI_SPAWN_INTERVAL !== 0) return state;
  const scheduledWaveCount =
    state.scheduledAiWaveCount ??
    Math.max(0, ...(state.aiFactions ?? []).filter((faction) => !faction.initial).map((faction) => faction.waveIndex ?? 0));
  const waveIndex = scheduledWaveCount + 1;
  const scaledWaveStat = Math.ceil(waveIndex * AI_SCHEDULED_POWER_SCALE);
  const basePower = Math.ceil(scaledWaveStat * getScheduledAiPowerMultiplier(state.currentMa));
  const basePopulation = AI_INITIAL_POPULATION + waveIndex * AI_SCHEDULED_POPULATION_STEP;
  const population = Math.ceil(basePopulation * getScheduledAiPopulationMultiplier(state.currentMa));

  const spawnedState = spawnAiFaction(state, {
    waveIndex,
    spawnTurn: state.turn,
    minRadius: AI_BOUNDARY_SPAWN_MIN_RADIUS,
    maxRadius: AI_BOUNDARY_SPAWN_MAX_RADIUS,
    maxAttempts: AI_SPAWN_MAX_ATTEMPTS,
    retryRadiusStep: AI_BOUNDARY_SPAWN_RETRY_RADIUS_STEP,
    salt: waveIndex * 100,
    initial: false,
    spawnFromPlayerBoundary: true,
    population,
    basePower,
    growthRate: scaledWaveStat,
    growthPower: 0,
    cycleForestPower: 0,
    tileCount: Math.max(1, Math.ceil(waveIndex * AI_SCHEDULED_TILE_SCALE))
  });
  return (spawnedState.aiFactions ?? []).length > (state.aiFactions ?? []).length
    ? { ...spawnedState, scheduledAiWaveCount: waveIndex }
    : spawnedState;
}

function chooseAiActionTarget(state, faction, kind, candidates) {
  // AI 先按 key 排序再随机选择，避免 Map 插入顺序影响结果。
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort((left, right) => {
    const leftKey = left.targetKey ?? left.key;
    const rightKey = right.targetKey ?? right.key;
    return leftKey.localeCompare(rightKey);
  });
  const random = stableRandom(state, faction.id * 1000 + (kind === "attack" ? 7 : 13));
  return ordered[Math.floor(random() * ordered.length)] ?? null;
}

function runAiFactionTurn(state, faction, averagePopulationBeforeGrowthByFaction = new Map()) {
  // 单个 AI 的行动优先级：
  // 1. 如果能以更高战力攻击玩家或其他 AI，则攻击；
  // 2. 否则尝试扩张到相邻可占领格子；
  // 3. 都不满足则跳过。
  const aiTiles = getAiTiles(state, faction.id);
  if (aiTiles.length === 0 || faction.spawnTurn >= state.turn) return state;

  const attackCandidates = [];
  const aiPower = getAiFactionPower(state, faction);
  const playerPower = getTotalPower(state);
  const aiAveragePopulation =
    averagePopulationBeforeGrowthByFaction.get(faction.id) ??
    (faction.population ?? AI_INITIAL_POPULATION) / Math.max(1, aiTiles.length);
  let shouldSkipExpansion = aiAveragePopulation < 2;
  for (const aiTile of aiTiles) {
    for (const neighbor of getNeighbors(aiTile)) {
      const targetKey = coordKey(neighbor);
      const targetTile = state.tiles.get(targetKey);
      if (targetTile?.owned) {
        const attackerPopulationLoss = getAttackerPopulationLoss(getPlayerDensityBattleSummary(state).cost);
        const hasEnoughPopulation = (faction.population ?? AI_INITIAL_POPULATION) > attackerPopulationLoss;
        if (aiPower > playerPower) {
          if (hasEnoughPopulation) {
            attackCandidates.push({ sourceKey: aiTile.key, targetKey, targetType: "player" });
          } else {
            shouldSkipExpansion = true;
          }
        }
      } else if (targetTile?.aiFactionId && targetTile.aiFactionId !== faction.id) {
        const defenderFaction = getAiFactionById(state, targetTile.aiFactionId);
        const attackerPopulationLoss = getAttackerPopulationLoss(getAiDensityCaptureCost(state, faction));
        const hasEnoughPopulation = (faction.population ?? AI_INITIAL_POPULATION) > attackerPopulationLoss;
        if (aiPower > getAiFactionPower(state, defenderFaction)) {
          if (hasEnoughPopulation) {
            attackCandidates.push({
              sourceKey: aiTile.key,
              targetKey,
              targetType: "ai",
              defenderFactionId: targetTile.aiFactionId
            });
          } else {
            shouldSkipExpansion = true;
          }
        }
      }
    }
  }

  const attack = chooseAiActionTarget(state, faction, "attack", attackCandidates);
  if (attack) {
    const targetTile = state.tiles.get(attack.targetKey);
    const nextTiles = new Map(state.tiles);
    if (attack.targetType === "player") {
      const captureSummary = getPlayerDensityBattleSummary(state);
      const basePopulationLoss = captureSummary.cost;
      const defenderPopulationLoss = getDefenderPopulationLoss(basePopulationLoss);
      const attackerPopulationLoss = getAttackerPopulationLoss(basePopulationLoss);
      nextTiles.set(attack.targetKey, {
        ...targetTile,
        owned: false,
        aiFactionId: faction.id,
        revealed: false,
        scouted: false
      });

      return removeExtinctAiFactions(
        appendLog(
          resetPlayerRevealedTiles({
            ...state,
            tiles: nextTiles,
            aiFactions: (state.aiFactions ?? []).map((candidate) =>
              candidate.id === faction.id
                ? {
                    ...candidate,
                    population: Math.max(0, (candidate.population ?? AI_INITIAL_POPULATION) - attackerPopulationLoss),
                    cycleForestPower: (candidate.cycleForestPower ?? 0) + (targetTile.terrain === "forest" ? 1 : 0)
                  }
                : candidate
            ),
            population: Math.max(0, state.population - defenderPopulationLoss),
            activeCoord:
              state.activeCoord && coordKey(state.activeCoord) === attack.targetKey ? { q: 0, r: 0 } : state.activeCoord
          }),
          `${state.currentMa} Ma：敌对族群攻占${tileLabel(targetTile)}，敌群损失 ${attackerPopulationLoss}，种群损失 ${defenderPopulationLoss}（${formatPlayerPopulationFormula(captureSummary)}）。`
        )
      );
    }

    const defenderFaction = getAiFactionById(state, attack.defenderFactionId);
    const attackerPopulationLoss = getAttackerPopulationLoss(getAiDensityCaptureCost(state, faction));
    const defenderPopulationLoss = getDefenderPopulationLoss(getAiDensityCaptureCost(state, defenderFaction));
    nextTiles.set(attack.targetKey, {
      ...targetTile,
      owned: false,
      aiFactionId: faction.id
    });

    return removeExtinctAiFactions(
      appendLog(
        {
          ...state,
          tiles: nextTiles,
          aiFactions: (state.aiFactions ?? []).map((candidate) => {
            if (candidate.id === faction.id) {
              return {
                ...candidate,
                population: Math.max(0, (candidate.population ?? AI_INITIAL_POPULATION) - attackerPopulationLoss),
                cycleForestPower: (candidate.cycleForestPower ?? 0) + (targetTile.terrain === "forest" ? 1 : 0)
              };
            }
            if (candidate.id === attack.defenderFactionId) {
              return {
                ...candidate,
                population: Math.max(0, (candidate.population ?? AI_INITIAL_POPULATION) - defenderPopulationLoss)
              };
            }
            return candidate;
          })
        },
        `${state.currentMa} Ma：敌群 #${faction.id} 攻占敌群 #${attack.defenderFactionId} 的${tileLabel(targetTile)}，攻击方损失 ${attackerPopulationLoss}，防守方损失 ${defenderPopulationLoss}。`
      )
    );
  }

  if (shouldSkipExpansion) return state;

  const expansionCandidates = [];
  // 扩张阶段只考虑可占领、未归属且未被玩家拥有的相邻格。
  for (const aiTile of aiTiles) {
    for (const neighbor of getNeighbors(aiTile)) {
      const key = coordKey(neighbor);
      const existingTile = state.tiles.get(key);
      const targetTile = existingTile ?? createTile(neighbor, state.turn, state.seed, false, state.terrainEpoch ?? 0);
      if (isOpenAiTile(targetTile)) {
        expansionCandidates.push({ key, tile: targetTile });
      }
    }
  }

  const affordableExpansions = expansionCandidates
    .map((candidate) => ({
      ...candidate,
      populationCost: getDynamicPopulationCost(state, candidate.tile)
    }))
    .filter((candidate) => faction.population > candidate.populationCost);
  const expansion = chooseAiActionTarget(state, faction, "expand", affordableExpansions);
  if (!expansion) return state;

  const nextTiles = new Map(state.tiles);
  nextTiles.set(expansion.key, {
    ...expansion.tile,
    owned: false,
    aiFactionId: faction.id,
    revealed: false,
    scouted: false
  });

  return removeExtinctAiFactions(
    appendLog(
      {
        ...state,
        tiles: nextTiles,
        aiFactions: (state.aiFactions ?? []).map((candidate) =>
          candidate.id === faction.id
            ? {
                ...candidate,
                population: Math.max(0, (candidate.population ?? AI_INITIAL_POPULATION) - expansion.populationCost),
                cycleForestPower: (candidate.cycleForestPower ?? 0) + (expansion.tile.terrain === "forest" ? 1 : 0)
              }
            : candidate
        )
      },
      `${state.currentMa} Ma：敌群 #${faction.id} 扩张到${tileLabel(expansion.tile)}，消耗 ${expansion.populationCost} 人口。`
    )
  );
}

function runAiTurns(state, averagePopulationBeforeGrowthByFaction = new Map()) {
  // 顺序执行所有 AI。每次行动后重新取 faction，确保前一个 AI 的结果会影响后一个 AI。
  return (state.aiFactions ?? []).reduce((nextState, faction) => {
    const currentFaction = getAiFactionById(nextState, faction.id);
    return currentFaction ? runAiFactionTurn(nextState, currentFaction, averagePopulationBeforeGrowthByFaction) : nextState;
  }, state);
}

export function hasAbility(state, abilityId) {
  // 能力由已解锁演化节点提供，而不是只看 currentSpeciesId。
  // 这样历史分支能力能持续生效。
  if (!abilityId) return false;
  const unlocked = new Set(state.unlockedMutationIds ?? ["primitive"]);
  return EVOLUTION_NODES.some((node) => unlocked.has(node.id) && node.abilityId === abilityId);
}

export function getTilePowerBonus(state) {
  // 玩家永久地形战力，含异变提供的地形额外加成。
  const rawBonus = getOwnedTiles(state).reduce((sum, tile) => {
    const ceratosaurusBonus = hasAbility(state, "skull_charge") && tile.terrain === "desert" ? 0.5 : 0;
    const mountainHoldBonus = hasAbility(state, "mountain_hold") && tile.terrain === "mountain" ? 1 : 0;
    return sum + tile.combatBonus + ceratosaurusBonus + mountainHoldBonus;
  }, 0);
  return Math.floor(rawBonus);
}

export function getTemporaryPowerBonus(state) {
  return state.temporaryPowerBonus ?? 0;
}

export function getPopulationMultiplierDelta(state) {
  // 人口倍率来自已占领地形，部分异变会让特定地形额外提高倍率。
  const tileDelta = getOwnedTiles(state).reduce((sum, tile) => {
    const coelurosaurBonus = hasAbility(state, "agile_breeding") && tile.terrain === "grassland" ? 1 : 0;
    const wetlandBroodBonus = hasAbility(state, "wetland_brood") && tile.terrain === "grassland" ? 1 : 0;
    const desertBroodBonus = hasAbility(state, "desert_brood") && tile.terrain === "desert" ? 0.5 : 0;
    const waterSettlementBonus = hasAbility(state, "water_settlement") && tile.terrain === "water" ? 1 : 0;
    return sum + tile.populationMultiplierDelta + coelurosaurBonus + wetlandBroodBonus + desertBroodBonus + waterSettlementBonus;
  }, 0);
  const quillGrowthBonus = hasAbility(state, "quill_growth") ? Math.floor(getOwnedTiles(state).length / 5) : 0;
  return tileDelta + quillGrowthBonus;
}

export function getPopulationMultiplier(state) {
  return Math.max(1, Math.floor(1 + getPopulationMultiplierDelta(state)));
}

export function getPopulationGrowth(state) {
  const baseGrowth = state.reproduction * getPopulationMultiplier(state);
  const lightClusterExtra = hasAbility(state, "light_cluster") ? Math.round(baseGrowth * 0.3) : 0;
  const featherGrowthExtra = hasAbility(state, "feather_growth") ? 2 : 0;
  return {
    baseGrowth,
    lightClusterExtra,
    featherGrowthExtra,
    totalGrowth: baseGrowth + lightClusterExtra + featherGrowthExtra
  };
}

export function getTotalPower(state) {
  // 总战力用于扩张和防御，包含基础战力、地形战力、临时战力和群猎能力。
  const packHuntBonus = hasAbility(state, "pack_hunt") ? Math.floor(getOwnedTiles(state).length / 5) : 0;
  return state.basePower + getTilePowerBonus(state) + getTemporaryPowerBonus(state) + packHuntBonus;
}

function getGeneratedTurn(state, tile) {
  return Number.isFinite(tile?.generatedTurn) ? tile.generatedTurn : state.turn ?? 0;
}

function getDynamicCombatRequirement(state, tile) {
  if (!tile || tile.conquerable === false) return tile?.combatRequired ?? 0;
  const currentPressure = getCombatRequirementPressure(state.turn ?? 0);
  const generatedPressure = getCombatRequirementPressure(getGeneratedTurn(state, tile));
  return tile.combatRequired + Math.max(0, currentPressure - generatedPressure);
}

function getDynamicPopulationCost(state, tile) {
  if (!tile || tile.conquerable === false) return tile?.populationCost ?? 0;
  const currentPressure = getPopulationCostPressure(state.turn ?? 0);
  const generatedPressure = getPopulationCostPressure(getGeneratedTurn(state, tile));
  return tile.populationCost + Math.max(0, currentPressure - generatedPressure);
}

export function getEffectiveCombatRequirement(state, tile) {
  // 玩家看到的实际战力要求会受能力和 AI 占领状态影响。
  // AI 格子要求至少达到该敌群战力。
  if (!tile || !isConquerableForPlayer(state, tile)) return tile?.combatRequired ?? 0;
  const crestThreatPenalty = hasAbility(state, "crest_threat") ? 1 : 0;
  const dynamicRequirement = tile.conquerable === false ? tile.combatRequired ?? 0 : getDynamicCombatRequirement(state, tile);
  const terrainRequirement = Math.max(0, dynamicRequirement - crestThreatPenalty);
  const finalRequirement = tile.aiFactionId ? Math.max(terrainRequirement, getTileAiPower(state, tile)) : terrainRequirement;
  const nimbleAdvancePenalty = hasAbility(state, "nimble_advance") ? 1 : 0;
  return Math.max(0, finalRequirement - nimbleAdvancePenalty);
}

function isAdjacentToTerrain(state, tile, terrainId) {
  return getNeighbors(tile).some((neighbor) => state.tiles.get(`${neighbor.q},${neighbor.r}`)?.terrain === terrainId);
}

export function getEffectivePopulationCost(state, tile) {
  // 计算玩家扩张普通格子的实际人口消耗。
  // 多个减免能力可以叠加，但不会把正成本压到 0 以下。
  if (!tile || !isConquerableForPlayer(state, tile)) return tile?.populationCost ?? 0;
  let cost = tile.conquerable === false ? tile.populationCost ?? 0 : getDynamicPopulationCost(state, tile);
  if (hasAbility(state, "burst_stride") && (state.cycleExpansionCount ?? 0) === 0) {
    return 0;
  }

  const minimumCost = cost > 0 ? 1 : 0;

  if (hasAbility(state, "ambush_hunter")) {
    cost = Math.round(cost * 0.8);
  }

  if (hasAbility(state, "shore_adaptation") && isAdjacentToTerrain(state, tile, "water")) {
    cost -= 2;
  }

  if (hasAbility(state, "scent_tracking")) {
    cost -= 1;
  }

  return Math.max(minimumCost, cost);
}

function getAiRecapturePopulationCost(state, factionId) {
  return getAttackerPopulationLoss(getAiDensityCaptureCost(state, getAiFactionById(state, factionId)));
}

export function getExpansionPopulationCost(state, tile) {
  // 收复 AI 格子使用敌群密度成本；普通格使用地形和能力修正后的成本。
  if (!tile) return 0;
  if (tile.aiFactionId) {
    const aiCost = getAiRecapturePopulationCost(state, tile.aiFactionId);
    return hasAbility(state, "bloodless_assault") ? Math.ceil(aiCost / 2) : aiCost;
  }
  return getEffectivePopulationCost(state, tile);
}

export function getPowerVictoryTarget(state) {
  // 霸王龙线降低总战力胜利门槛。
  return hasAbility(state, "apex_bite") ? VICTORY.basePower - 50 : VICTORY.basePower;
}

function getCycleMutationPointGain(state) {
  const adaptiveBonus =
    (hasAbility(state, "adaptive_mutation_gain_1") ? 0.5 : 0) +
    (hasAbility(state, "adaptive_mutation_gain_2") ? 0.5 : 0) +
    (hasAbility(state, "flight_to_new_world") ? 1 : 0);
  return 1 + adaptiveBonus;
}

export function canExpandTo(state, tile) {
  // 玩家扩张的完整门槛：可见、已揭示、可征服、战力足够、人口超过成本、
  // 本回合尚未扩张、没有待选升级、游戏未结束。
  if (!tile || !state.visibleKeys?.includes(tile.key)) return false;
  const combatRequirement = getEffectiveCombatRequirement(state, tile);
  const hasEnoughPower = getTotalPower(state) > combatRequirement;

  return Boolean(
      tile.revealed &&
      !tile.owned &&
      isConquerableForPlayer(state, tile) &&
      !(tile.aiFactionId && hasAbility(state, "brood_focus")) &&
      hasEnoughPower &&
      state.population > getExpansionPopulationCost(state, tile) &&
      !state.hasExpandedThisTurn &&
      !state.pendingMutationChoice &&
      !state.gameOver
  );
}

export function canPlayerConquerTile(state, tile) {
  return Boolean(
    tile &&
      (tile.conquerable !== false ||
        (tile.terrain === "mountain" && hasAbility(state, "mountain_hold")) ||
        (tile.terrain === "water" && hasAbility(state, "water_settlement")))
  );
}

function isConquerableForPlayer(state, tile) {
  return canPlayerConquerTile(state, tile);
}

function getMutationAttributes(state) {
  return {
    power: state.mutationAttributes?.power ?? 0,
    agility: state.mutationAttributes?.agility ?? 0,
    adaptation: state.mutationAttributes?.adaptation ?? 0
  };
}

function getUnlockedUncommonAttributes(state) {
  const attributes = getMutationAttributes(state);
  return Object.keys(MUTATION_ATTRIBUTES).filter((attribute) => attributes[attribute] >= UNCOMMON_ATTRIBUTE_THRESHOLD);
}

function getOwnedTerrainCount(state, terrainId) {
  return getOwnedTiles(state).filter((tile) => tile.terrain === terrainId).length;
}

function hasVisibleTerrain(state, terrainId) {
  return [...state.tiles.values()].some((tile) => tile.revealed && tile.terrain === terrainId);
}

export function getMutationPressures(state) {
  // 压力标签只影响高级槽刷新权重；不会让槽位空掉。
  const ownedTiles = getOwnedTiles(state);
  const pressureSet = new Set();
  const reasons = [];
  const add = (tag, reason) => {
    pressureSet.add(tag);
    reasons.push(reason);
  };

  if (state.population < Math.max(30, ownedTiles.length * 3)) add("low_population", "人口偏低");
  if (state.population < ownedTiles.length * 2) add("sparse_density", "种群密度不足");
  if (state.reproduction >= state.basePower) add("growth_focus", "繁殖倾向");
  if (state.basePower >= state.reproduction) add("power_focus", "战力倾向");
  if (ownedTiles.length >= 6) add("many_tiles", "领地规模扩大");
  if ((state.cycleExpansionCount ?? 0) >= 2 || ownedTiles.length >= 8) add("rapid_expansion", "快速扩张");
  if (state.turn >= 45) add("late_game", "演化进入中后期");
  if (state.lastMassExtinctionTurn !== undefined && state.turn - state.lastMassExtinctionTurn <= 8) {
    add("post_extinction", "灾后恢复");
  }

  if (ownedTiles.some((tile) => isTileThreatenedByAi(state, tile))) add("ai_border", "敌群接壤");
  if (getOwnedTerrainCount(state, "desert") > 0) add("desert_owned", "沙漠领地");
  if (getOwnedTerrainCount(state, "grassland") > 0) add("grassland_owned", "湿地领地");
  if (hasVisibleTerrain(state, "forest")) add("forest_frontier", "森林前线");
  if (hasVisibleTerrain(state, "water")) add("water_frontier", "水域阻隔");
  if (hasVisibleTerrain(state, "water") || hasVisibleTerrain(state, "mountain")) add("exploration_blocked", "探索受阻");

  return {
    tags: [...pressureSet],
    reasons: [...new Set(reasons)]
  };
}

function mutationWeightForState(state, node, pressureTags) {
  let weight = 1;
  for (const tag of node.pressureTags ?? []) {
    if (pressureTags.includes(tag)) weight += 3;
  }
  if (state.basePower >= node.minPower) weight += 1;
  if (state.reproduction >= node.minReproduction) weight += 1;
  if (state.basePower < node.minPower - 3 || state.reproduction < node.minReproduction - 3) weight *= 0.5;
  return Math.max(0.1, weight);
}

function pickWeightedMutation(state, slot, rarity, excludedIds, pressures, attribute = null) {
  const unlocked = new Set(state.unlockedMutationIds ?? ["primitive"]);
  const candidates = getAdvancedMutationNodes().filter(
    (node) =>
      node.rarity === rarity &&
      (!attribute || node.attribute === attribute) &&
      !unlocked.has(node.id) &&
      !excludedIds.has(node.id)
  );
  if (candidates.length === 0) return null;

  const weighted = candidates
    .map((node) => ({
      node,
      weight: mutationWeightForState(state, node, pressures.tags)
    }))
    .filter((candidate) => candidate.weight > 0);
  if (weighted.length === 0) return null;

  const random = stableRandom(state, slot * 7919 + rarity.charCodeAt(0) * 97);
  const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = random() * totalWeight;
  for (const candidate of weighted) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.node;
  }
  return weighted.at(-1).node;
}

function pickUncommonAttribute(state, slot, excludedIds, pressures) {
  const unlockedAttributes = getUnlockedUncommonAttributes(state);
  const availableAttributes = unlockedAttributes.filter((attribute) =>
    getAdvancedMutationNodes().some(
      (node) =>
        node.rarity === "uncommon" &&
        node.attribute === attribute &&
        !(state.unlockedMutationIds ?? ["primitive"]).includes(node.id) &&
        !excludedIds.has(node.id)
    )
  );
  if (availableAttributes.length === 0) return null;

  const random = stableRandom(state, slot * 1297 + 211);
  const weighted = availableAttributes.map((attribute) => {
    const bestWeight = getAdvancedMutationNodes()
      .filter((node) => node.rarity === "uncommon" && node.attribute === attribute)
      .reduce((max, node) => Math.max(max, mutationWeightForState(state, node, pressures.tags)), 0.1);
    return { attribute, weight: bestWeight };
  });
  const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = random() * totalWeight;
  for (const candidate of weighted) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.attribute;
  }
  return weighted.at(-1).attribute;
}

function createFreeMutationChoice(kind) {
  return {
    id: kind,
    type: "basic",
    slot: kind === "basic_reproduction" ? 1 : 2,
    name: kind === "basic_reproduction" ? "繁殖能力 +1" : "基础战力 +1",
    rarity: "basic",
    rarityLabel: "基础",
    cost: 0,
    abilityName: kind === "basic_reproduction" ? "稳定繁殖" : "稳定战力",
    abilityDescription:
      kind === "basic_reproduction"
        ? "永久提高繁殖能力 1 点。"
        : "永久提高基础战力 1 点。",
    pressureReasons: ["固定基础异变"],
    available: true
  };
}

function createLockedAdvancedChoice(slot, unlockTurn) {
  return {
    id: `locked_slot_${slot}`,
    type: "locked",
    slot,
    name: "高级异变槽",
    rarity: "locked",
    rarityLabel: "未开放",
    cost: 0,
    abilityName: "尚未稳定",
    abilityDescription: `第 ${unlockTurn} 回合后开放。`,
    pressureReasons: [`第 ${unlockTurn} 回合开放`],
    available: false,
    lockedReason: `第 ${unlockTurn} 回合开放`
  };
}

function createAdvancedMutationChoice(state, slot, excludedIds, pressures) {
  const unlockTurn = slot === 3 ? RARE_SLOT_UNLOCK_TURN : SECOND_ADVANCED_SLOT_UNLOCK_TURN;
  if (state.turn < unlockTurn) return createLockedAdvancedChoice(slot, unlockTurn);

  const random = stableRandom(state, slot * 3571 + 29);
  let node = null;
  if (random() < UNCOMMON_MUTATION_CHANCE) {
    const uncommonAttribute = pickUncommonAttribute(state, slot, excludedIds, pressures);
    if (uncommonAttribute) {
      node = pickWeightedMutation(state, slot, "uncommon", excludedIds, pressures, uncommonAttribute);
    }
  }
  node = node ?? pickWeightedMutation(state, slot, "rare", excludedIds, pressures);
  if (!node) return createLockedAdvancedChoice(slot, unlockTurn);

  excludedIds.add(node.id);
  const rarityConfig = getMutationRarity(node.rarity);
  const attributeConfig = getMutationAttribute(node.attribute);
  const matchedReasons = (node.pressureTags ?? []).filter((tag) => pressures.tags.includes(tag));
  return {
    id: node.id,
    mutationId: node.id,
    type: "advanced",
    slot,
    name: node.abilityName,
    rarity: node.rarity,
    rarityLabel: rarityConfig?.label ?? "高级",
    attribute: node.attribute,
    attributeLabel: attributeConfig?.label ?? "高级",
    cost: rarityConfig?.cost ?? node.mutationCost,
    abilityName: node.abilityName,
    abilityDescription: node.abilityDescription,
    pressureReasons: matchedReasons.length > 0 ? pressures.reasons.slice(0, 3) : ["稳定随机候选"],
    available: Math.floor(state.mutationPoints ?? 0) >= (rarityConfig?.cost ?? node.mutationCost)
  };
}

export function generateMutationChoices(state) {
  const pressures = getMutationPressures(state);
  const excludedIds = new Set();
  return [
    createFreeMutationChoice("basic_reproduction"),
    createFreeMutationChoice("basic_power"),
    createAdvancedMutationChoice(state, 3, excludedIds, pressures),
    createAdvancedMutationChoice(state, 4, excludedIds, pressures)
  ];
}

export function canChooseMutation(state, choiceId) {
  if (!state.pendingMutationChoice || state.gameOver) return false;
  const choice = (state.mutationChoices ?? []).find((candidate) => candidate.id === choiceId);
  if (!choice || choice.type === "locked") return false;
  return Math.floor(state.mutationPoints ?? 0) >= (choice.cost ?? 0);
}

export function ensureVisibleTilesForState(state) {
  // 将已解锁能力转换成地图模块的可见性选项。
  return ensureVisibleTiles(state, {
    waterPassage: hasAbility(state, "water_passage"),
    scoutOuterRing: hasAbility(state, "scent_tracking")
  });
}

function resetAndEnsureVisibleTilesForState(state) {
  return ensureVisibleTilesForState(resetPlayerRevealedTiles(state));
}

export function checkVictory(state) {
  // 终局只在陨石事件或测试显式调用时判定。
  // 飞向新世界是特殊终局，优先于人口和总战力路线显示。
  if (hasAbility(state, "flight_to_new_world") && (state.mutationAttributes?.adaptation ?? 0) >= 5) {
    return {
      type: "adaptation",
      title: "适应胜利",
      message: "羽毛、羽管与迁徙能力完成稳定遗传，种群飞向新世界，避开旧大陆灾变。"
    };
  }

  if (state.population >= VICTORY.population) {
    return {
      type: "population",
      title: "种群冗余胜利",
      message: "陨石引发全球灾变，但分布广大的种群保留了足够幸存者。"
    };
  }

  if (getTotalPower(state) >= getPowerVictoryTarget(state)) {
    return {
      type: "power",
      title: "巨兽抗灾胜利",
      message: "个体身体强度达到极限，在灾变后仍有大型幸存种群延续。"
    };
  }

  return {
    type: "extinction",
    title: "灭绝失败",
    message: "种群规模和个体强度都不足以穿过白垩纪末期的灾变。"
  };
}

function getExtinctionFailureResult(message = "总人口归零，种群无法继续维持。") {
  return {
    type: "extinction",
    title: "灭绝失败",
    message
  };
}

function failIfExtinct(state) {
  // 任意动作前后都可以调用该函数，统一处理“没有人口”或“没有领地”的失败。
  if (state.gameOver) return state;
  const hasPopulation = state.population > 0;
  const hasTerritory = getOwnedTiles(state).length > 0;
  if (hasPopulation && hasTerritory) return state;
  const message = hasPopulation ? "所有领地丧失，种群无法继续维持。" : "总人口归零，种群无法继续维持。";
  const logMessage = hasPopulation
    ? `${state.currentMa} Ma：所有领地丧失，种群灭绝。`
    : `${state.currentMa} Ma：总人口归零，种群灭绝。`;
  return appendLog(
    {
      ...state,
      population: Math.max(0, state.population),
      gameOver: true,
      pendingMutationChoice: false,
      mutationChoices: [],
      result: getExtinctionFailureResult(message)
    },
    logMessage
  );
}

function getLogTurn(entry, fallbackState) {
  const match = String(entry).match(/^(\d+)\s+Ma[：:]/);
  return {
    turn: fallbackState.turn ?? 0,
    ma: match ? Number(match[1]) : fallbackState.currentMa
  };
}

function getLoggedPopulation(state) {
  return Math.max(0, Math.floor(state.population ?? 0));
}

function shouldShowInGameOverHistory(entry) {
  const text = String(entry);
  return !(
    text.includes("敌群人口增长") ||
    text.includes("敌群周期成长") ||
    text.includes("敌群 #")
  );
}

function appendRecentTurnHistory(state, entry) {
  const { turn, ma } = getLogTurn(entry, state);
  const populationAfter = getLoggedPopulation(state);
  const populationBefore = Number.isFinite(state.lastLoggedPopulation)
    ? Math.max(0, Math.floor(state.lastLoggedPopulation))
    : populationAfter;
  const event = {
    text: entry,
    populationBefore,
    populationAfter,
    populationDelta: populationAfter - populationBefore,
    showInGameOver: shouldShowInGameOverHistory(entry)
  };
  const currentHistory = state.recentTurnHistory ?? [];
  const nextHistory =
    currentHistory[0]?.turn === turn && currentHistory[0]?.ma === ma
      ? [
          {
            ...currentHistory[0],
            populationAfter,
            populationDelta: populationAfter - currentHistory[0].populationBefore,
            events: [...currentHistory[0].events, event]
          },
          ...currentHistory.slice(1)
        ]
      : [
          {
            turn,
            ma,
            populationBefore,
            populationAfter,
            populationDelta: populationAfter - populationBefore,
            events: [event]
          },
          ...currentHistory
        ];

  return {
    ...state,
    lastLoggedPopulation: populationAfter,
    recentTurnHistory: nextHistory.slice(0, 8)
  };
}

function appendLog(state, entry) {
  // 日志只保留最近 14 条，避免 DOM 长列表无限增长。
  const historyState = appendRecentTurnHistory(state, entry);
  return {
    ...historyState,
    log: [entry, ...historyState.log].slice(0, 14)
  };
}

export function getRecentTurnHistory(state, count = 2) {
  return (state.recentTurnHistory ?? []).slice(0, count);
}

function appendNotice(state, notice) {
  // notice 是需要 UI 弹窗逐条确认的事件队列。
  return {
    ...state,
    notices: [...(state.notices ?? []), notice]
  };
}

function getSortedOwnedKeys(state) {
  return getOwnedTiles(state)
    .map((tile) => tile.key)
    .sort((left, right) => left.localeCompare(right));
}

function findTerritoryComponents(state, sortedKeys) {
  const territoryKeys = new Set(sortedKeys);
  const visited = new Set();
  const components = [];

  for (const startKey of territoryKeys) {
    if (visited.has(startKey)) continue;
    const queue = [startKey];
    const keys = [];
    visited.add(startKey);

    for (let index = 0; index < queue.length; index += 1) {
      const key = queue[index];
      const tile = state.tiles.get(key);
      if (!tile) continue;
      keys.push(key);

      for (const neighbor of getNeighbors(tile)) {
        const neighborKey = coordKey(neighbor);
        if (territoryKeys.has(neighborKey) && !visited.has(neighborKey)) {
          visited.add(neighborKey);
          queue.push(neighborKey);
        }
      }
    }

    components.push(keys.sort((left, right) => left.localeCompare(right)));
  }

  return components;
}

function findOwnedTerritoryComponents(state) {
  return findTerritoryComponents(state, getSortedOwnedKeys(state));
}

function getSortedAiKeys(state, factionId) {
  return getAiTiles(state, factionId)
    .map((tile) => tile.key)
    .sort((left, right) => left.localeCompare(right));
}

function findAiTerritoryComponents(state, factionId) {
  return findTerritoryComponents(state, getSortedAiKeys(state, factionId));
}

function compareTerritoryComponents(left, right) {
  if (left.length !== right.length) return right.length - left.length;
  const leftHasOrigin = left.includes("0,0");
  const rightHasOrigin = right.includes("0,0");
  if (leftHasOrigin !== rightHasOrigin) return leftHasOrigin ? -1 : 1;
  return left[0].localeCompare(right[0]);
}

function getHabitatCutoffSummary(state) {
  const ownedKeys = getSortedOwnedKeys(state);
  if (ownedKeys.length <= 1) {
    return {
      isolatedKeys: [],
      keptKeys: new Set(ownedKeys),
      populationLoss: 0,
      populationPerTile: ownedKeys.length > 0 ? Math.ceil(state.population / ownedKeys.length) : 0
    };
  }

  const components = findOwnedTerritoryComponents(state).sort(compareTerritoryComponents);
  const keptKeys = new Set(components[0] ?? []);
  const isolatedKeys = components.slice(1).flat();
  const populationPerTile = Math.ceil(state.population / ownedKeys.length);
  return {
    isolatedKeys,
    keptKeys,
    populationLoss: isolatedKeys.length * populationPerTile,
    populationPerTile
  };
}

function getAiHabitatCutoffSummary(state, faction) {
  const aiKeys = getSortedAiKeys(state, faction.id);
  const population = faction.population ?? AI_INITIAL_POPULATION;
  if (aiKeys.length <= 1) {
    return {
      isolatedKeys: [],
      populationLoss: 0,
      populationPerTile: aiKeys.length > 0 ? Math.ceil(population / aiKeys.length) : 0
    };
  }

  const components = findAiTerritoryComponents(state, faction.id).sort(compareTerritoryComponents);
  const isolatedKeys = components.slice(1).flat();
  const populationPerTile = Math.ceil(population / aiKeys.length);
  return {
    isolatedKeys,
    populationLoss: isolatedKeys.length * populationPerTile,
    populationPerTile
  };
}

function applyHabitatCutoffPenalty(state) {
  // 回合开始时只保留最大连通栖息地；被切断的孤立领地会丧失并带来人口损失。
  const ownedTiles = getOwnedTiles(state);
  const summary = getHabitatCutoffSummary(state);
  if (summary.isolatedKeys.length === 0) return state;

  const nextTiles = new Map(state.tiles);
  for (const key of summary.isolatedKeys) {
    const tile = nextTiles.get(key);
    if (tile) {
      nextTiles.set(key, { ...tile, owned: false, revealed: false, scouted: false });
    }
  }

  const nextPopulation = Math.max(0, state.population - summary.populationLoss);
  const activeCoord = getSurvivingActiveCoord(nextTiles, state.activeCoord);
  const nextState = resetAndEnsureVisibleTilesForState({
    ...state,
    tiles: nextTiles,
    population: nextPopulation,
    activeCoord
  });

  return appendNotice(
    appendLog(
      nextState,
      `${state.currentMa} Ma：栖息地被切断，失去 ${summary.isolatedKeys.length} 个孤立领地，种群损失 ${summary.populationLoss}。`
    ),
    {
      type: "habitat-cutoff",
      title: "栖息地切断",
      eyebrow: `${state.currentMa} Ma`,
      message: "主栖息地之外的孤立领地无法继续维持，局部种群随之崩溃。",
      populationBefore: Math.floor(state.population),
      populationAfter: Math.floor(nextPopulation),
      tilesBefore: ownedTiles.length,
      tilesAfter: ownedTiles.length - summary.isolatedKeys.length,
      removedTileCount: summary.isolatedKeys.length,
      populationLoss: summary.populationLoss,
      populationPerTile: summary.populationPerTile
    }
  );
}

function applyAiHabitatCutoffPenalties(state) {
  // AI 也只保留各自最大连通栖息地，但不向玩家弹出 notice。
  let nextState = state;

  for (const faction of state.aiFactions ?? []) {
    const currentFaction = getAiFactionById(nextState, faction.id);
    if (!currentFaction) continue;

    const summary = getAiHabitatCutoffSummary(nextState, currentFaction);
    if (summary.isolatedKeys.length === 0) continue;

    const nextTiles = new Map(nextState.tiles);
    for (const key of summary.isolatedKeys) {
      const tile = nextTiles.get(key);
      if (tile) {
        nextTiles.set(key, { ...tile, aiFactionId: null, revealed: false, scouted: false });
      }
    }

    nextState = appendLog(
      {
        ...nextState,
        tiles: nextTiles,
        aiFactions: (nextState.aiFactions ?? []).map((candidate) =>
          candidate.id === currentFaction.id
            ? {
                ...candidate,
                population: Math.max(0, (candidate.population ?? AI_INITIAL_POPULATION) - summary.populationLoss)
              }
            : candidate
        )
      },
      `${nextState.currentMa} Ma：敌群 #${currentFaction.id} 栖息地被切断，失去 ${summary.isolatedKeys.length} 个孤立领地，人口损失 ${summary.populationLoss}。`
    );
  }

  return nextState === state ? state : ensureVisibleTilesForState(removeExtinctAiFactions(nextState));
}

function shuffleTiles(tiles, random) {
  // 先按 key 排序再洗牌，避免 Map 插入顺序影响灾变结果。
  const shuffled = [...tiles].sort((left, right) => left.key.localeCompare(right.key));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function applyExtinctionPopulationLoss(population) {
  // 大灭绝保留 10% 人口，非零人口至少留下 1。
  return population > 0 ? Math.max(1, Math.floor(population * 0.1)) : 0;
}

export function selectMassExtinctionSurvivorKeys(tiles, population, random) {
  // 大灭绝幸存领地必须来自同一个灾前连通块，再从随机起点向外生长。
  const targetCount = Math.min(Math.round(Math.floor(population) / 20), tiles.length, MASS_EXTINCTION_MAX_SURVIVOR_TILES);
  if (targetCount <= 0 || tiles.length === 0) return new Set();

  const tileByKey = new Map(tiles.map((tile) => [tile.key, tile]));
  const components = findTerritoryComponents(
    { tiles: tileByKey },
    [...tileByKey.keys()].sort((left, right) => left.localeCompare(right))
  ).sort(compareTerritoryComponents);
  const componentKeys = components[0] ?? [];
  const survivorCount = Math.min(targetCount, componentKeys.length);
  if (survivorCount <= 0) return new Set();

  const componentKeySet = new Set(componentKeys);
  const selectedKeys = new Set();
  const startKey = shuffleTiles(componentKeys.map((key) => tileByKey.get(key)), random)[0].key;
  selectedKeys.add(startKey);

  while (selectedKeys.size < survivorCount) {
    const frontier = [];
    for (const key of selectedKeys) {
      const tile = tileByKey.get(key);
      if (!tile) continue;
      for (const neighbor of getNeighbors(tile)) {
        const neighborKey = coordKey(neighbor);
        if (componentKeySet.has(neighborKey) && !selectedKeys.has(neighborKey) && !frontier.includes(neighborKey)) {
          frontier.push(neighborKey);
        }
      }
    }

    if (frontier.length === 0) break;
    const nextKey = frontier.sort((left, right) => left.localeCompare(right))[Math.floor(random() * frontier.length)];
    selectedKeys.add(nextKey);
  }

  return selectedKeys;
}

function rerollTileTerrain(state, tile, terrainEpoch, forceConquerable = false) {
  const random = mulberry32(coordinateSeed(state.seed, tile, state.turn, terrainEpoch));
  const terrainId = weightedTerrain(random, forceConquerable ? CONQUERABLE_TERRAIN_WEIGHTS : TERRAIN_WEIGHTS);
  const terrain = TERRAIN_TYPES[terrainId];
  const conquerable = terrain.conquerable;

  return {
    ...tile,
    terrain: terrainId,
    combatRequired: conquerable ? generateTileCombatRequirement(state.turn, terrainId, random) : 0,
    populationCost: conquerable ? generateTilePopulationCost(state.turn, terrainId, random) : 0,
    populationMultiplierDelta: terrain.populationMultiplierDelta,
    combatBonus: terrain.combatBonus,
    conquerable,
    generatedTurn: state.turn
  };
}

function getSurvivingActiveCoord(tiles, activeCoord) {
  // 如果当前选中领地没幸存，切换到排序后的第一个幸存领地。
  const activeTile = tiles.get(`${activeCoord?.q},${activeCoord?.r}`);
  if (activeTile?.owned) return activeCoord;
  const ownedTile = [...tiles.values()].filter((tile) => tile.owned).sort((left, right) => left.key.localeCompare(right.key))[0];
  return ownedTile ? { q: ownedTile.q, r: ownedTile.r } : { q: 0, r: 0 };
}

function applySparsePopulationTerritoryLoss(state) {
  // 人口小于领地数两倍时，随机失去 1 个边缘领地（边缘定义为至少有一个非 owned 邻居的格子）。
  const ownedTiles = getOwnedTiles(state);
  const ownedKeySet = new Set(ownedTiles.map((tile) => tile.key));
  const removableTiles = ownedTiles.filter((tile) =>
    tile.key !== "0,0" && getNeighbors(tile).some((n) => !ownedKeySet.has(coordKey(n)))
  );
  const isSparse = state.population < ownedTiles.length * 2;
  const removedTileCount = isSparse && removableTiles.length > 0 ? 1 : 0;
  const random = mulberry32((state.seed ^ Math.imul(state.turn, 2246822519) ^ 0x9e3779b9) >>> 0);
  const nextTiles = new Map(state.tiles);

  if (removedTileCount > 0) {
    const removedKeys = new Set(shuffleTiles(removableTiles, random).slice(0, removedTileCount).map((tile) => tile.key));
    for (const key of removedKeys) {
      const tile = nextTiles.get(key);
      nextTiles.set(key, { ...tile, owned: false, revealed: false, scouted: false });
    }
  }

  const activeTile = nextTiles.get(`${state.activeCoord?.q},${state.activeCoord?.r}`);
  const activeCoord = activeTile?.owned ? state.activeCoord : { q: 0, r: 0 };
  const sparseState = {
    ...state,
    tiles: nextTiles,
    activeCoord
  };
  const nextState =
    removedTileCount > 0 ? resetAndEnsureVisibleTilesForState(sparseState) : ensureVisibleTilesForState(sparseState);
  const loggedState = appendLog(
    nextState,
    removedTileCount > 0
      ? `${state.currentMa} Ma：种群过于稀疏，失去 ${removedTileCount} 个边缘领地。`
      : `${state.currentMa} Ma：种群密度检查通过，领地暂时稳定。`
  );

  if (removedTileCount === 0) {
    return loggedState;
  }

  return appendNotice(loggedState, {
    type: "population-density",
    title: "种群密度检查",
    eyebrow: `${state.currentMa} Ma`,
    message: "当前人口不足以支撑全部领地。",
    populationBefore: Math.floor(state.population),
    populationAfter: Math.floor(state.population),
    tilesBefore: ownedTiles.length,
    tilesAfter: ownedTiles.length - removedTileCount,
    removedTileCount,
    threshold: ownedTiles.length * 2
  });
}

function applyMassExtinction(state, event) {
  // 历史大灭绝同时作用于玩家和 AI：
  // 先按各自人口决定一片连通幸存领地，再把人口压缩到 10%，并重塑灾后地形。
  const ownedTiles = getOwnedTiles(state);
  const previousPopulation = Math.floor(state.population);
  const random = mulberry32((state.seed ^ Math.imul(event.boundaryMa, 2654435761) ^ Math.imul(state.turn, 1597334677)) >>> 0);
  const survivorKeys = selectMassExtinctionSurvivorKeys(ownedTiles, previousPopulation, random);
  const removedTileCount = ownedTiles.length - survivorKeys.size;
  const aiSurvivorKeysByFactionId = new Map();

  for (const faction of state.aiFactions ?? []) {
    const aiPopulation = Math.floor(faction.population ?? AI_INITIAL_POPULATION);
    const aiTiles = getAiTiles(state, faction.id);
    const aiSurvivorKeys = selectMassExtinctionSurvivorKeys(aiTiles, aiPopulation, random);
    aiSurvivorKeysByFactionId.set(faction.id, aiSurvivorKeys);
  }

  const terrainEpoch = (state.terrainEpoch ?? 0) + 1;
  const nextTiles = new Map();

  for (const [key, tile] of state.tiles) {
    const playerSurvives = survivorKeys.has(key);
    const survivingAiFaction = (state.aiFactions ?? []).find((faction) => aiSurvivorKeysByFactionId.get(faction.id)?.has(key));
    const resetTile = rerollTileTerrain(state, tile, terrainEpoch, playerSurvives || Boolean(survivingAiFaction));

    nextTiles.set(key, {
      ...resetTile,
      owned: playerSurvives,
      aiFactionId: survivingAiFaction ? survivingAiFaction.id : null,
      revealed: playerSurvives || survivingAiFaction ? tile.revealed || playerSurvives : false,
      scouted: false
    });
  }

  const nextPopulation = applyExtinctionPopulationLoss(state.population);
  const nextAiFactions = (state.aiFactions ?? []).map((faction) => ({
    ...faction,
    population: applyExtinctionPopulationLoss(faction.population ?? AI_INITIAL_POPULATION)
  }));
  const activeCoord = getSurvivingActiveCoord(nextTiles, state.activeCoord);
  const massExtinctionState = {
    ...state,
    terrainEpoch,
    tiles: nextTiles,
    population: nextPopulation,
    aiFactions: nextAiFactions,
    activeCoord,
    lastMassExtinctionTurn: state.turn
  };
  const nextState = removeExtinctAiFactions(
    removedTileCount > 0
      ? resetAndEnsureVisibleTilesForState(massExtinctionState)
      : ensureVisibleTilesForState(massExtinctionState)
  );

  return appendNotice(
    appendLog(
      nextState,
      `${state.currentMa} Ma：${event.label}大灭绝爆发，世界地形重塑，仅有 ${survivorKeys.size} 个相连原有格子幸存，种群损失 90%。`
    ),
    {
      type: "mass-extinction",
      title: `${event.label}大灭绝`,
      eyebrow: `${state.currentMa} Ma`,
      message: "气候、海平面与食物链同时崩塌，幸存栖息地收缩成一片相连残区，世界地形被重新塑造。",
      populationBefore: previousPopulation,
      populationAfter: nextPopulation,
      tilesBefore: ownedTiles.length,
      tilesAfter: survivorKeys.size,
      removedTileCount
    }
  );
}

function applyRandomEventNotice(state) {
  // 随机事件先修改 state，再把事件载荷转为日志和 UI notice。
  const nextState = applyRandomEvent(state);
  const { randomEvent, ...stateWithoutEventPayload } = removeExtinctAiFactions(nextState);
  return appendNotice(
    appendLog(
      stateWithoutEventPayload,
      `${state.currentMa} Ma：${randomEvent.rarityLabel}事件「${randomEvent.title}」触发，${randomEvent.effectSummary}。`
    ),
    {
      type: "random-event",
      title: randomEvent.title,
      eyebrow: `${state.currentMa} Ma · ${randomEvent.rarityLabel}事件`,
      message: randomEvent.message,
      eventId: randomEvent.eventId,
      rarity: randomEvent.rarity,
      rarityLabel: randomEvent.rarityLabel,
      effectSummary: randomEvent.effectSummary
    }
  );
}

function applyMassExtinctions(state, previousMa, nextMa) {
  // 只有从边界 Ma 跨到更小 Ma 时触发，避免停在边界年份重复触发。
  return MASS_EXTINCTIONS.reduce((nextState, event) => {
    if (previousMa >= event.boundaryMa && nextMa < event.boundaryMa) {
      return applyMassExtinction(nextState, event);
    }
    return nextState;
  }, state);
}

export function chooseMutation(state, choiceId) {
  // 周期 4 选 1：基础项直接改属性，高级项写入永久异变记录。
  state = failIfExtinct(state);
  if (state.gameOver) return state;
  if (!canChooseMutation(state, choiceId)) {
    return appendLog(state, `${state.currentMa} Ma：异变选择尚未满足条件。`);
  }

  const choice = (state.mutationChoices ?? []).find((candidate) => candidate.id === choiceId);
  if (choice.type === "basic") {
    const populationBonus = choice.id === "basic_reproduction" && hasAbility(state, "thermal_plumage") ? 1 : 0;
    const nextState = {
      ...state,
      pendingMutationChoice: false,
      mutationChoices: [],
      basePower: choice.id === "basic_power" ? state.basePower + 1 : state.basePower,
      reproduction: choice.id === "basic_reproduction" ? state.reproduction + 1 : state.reproduction,
      population: state.population + populationBonus
    };
    return ensureVisibleTilesForState(
      appendLog(
        nextState,
        `${state.currentMa} Ma：选择永久异变「${choice.name}」${populationBonus ? "，羽毛保温额外获得 1 人口" : ""}。`
      )
    );
  }

  const node = getSpeciesNode(choice.mutationId);
  const nextMutationAttributes = {
    ...getMutationAttributes(state),
    [node.attribute]: (getMutationAttributes(state)[node.attribute] ?? 0) + 1
  };
  const populationAfterMutation = node.abilityId === "last_stand_surge" ? 1 : state.population;
  const basePowerAfterMutation = state.basePower + (node.abilityId === "last_stand_surge" ? 50 : 0);
  const reproductionAfterMutation = state.reproduction + (node.abilityId === "brood_focus" ? 20 : 0);
  const mutationPointRefund = node.abilityId === "flight_to_new_world" ? 2 : 0;
  return appendLog(
    ensureVisibleTilesForState({
      ...state,
      pendingMutationChoice: false,
      mutationChoices: [],
      currentSpeciesId: node.id,
      mutationPoints: state.mutationPoints - choice.cost + mutationPointRefund,
      population: populationAfterMutation,
      basePower: basePowerAfterMutation,
      reproduction: reproductionAfterMutation,
      mutationAttributes: nextMutationAttributes,
      unlockedMutationIds: [...state.unlockedMutationIds, node.id]
    }),
    `${state.currentMa} Ma：花费 ${choice.cost} 变异点，稳定遗传「${node.abilityName}」，${getMutationAttribute(node.attribute)?.label ?? "属性"} +1${mutationPointRefund > 0 ? `，返还 ${mutationPointRefund} 变异点` : ""}。`
  );
}

export function unlockMutation(state, nodeId) {
  // 兼容旧入口：只有当该节点出现在当前高级候选中时才会成功。
  return chooseMutation(state, nodeId);
}

export function canUnlockMutation(state, nodeId) {
  return canChooseMutation(state, nodeId);
}

export function chooseUpgrade(state, stat) {
  // 兼容旧测试/入口：映射到新的免费基础异变。
  return chooseMutation(state, stat === "power" ? "basic_power" : "basic_reproduction");
}

export function expandToTile(state, tileKey) {
  // 扩张会立即占领格子、扣人口、应用地形临时战力，并刷新可见边界。
  // UI 当前实现会在扩张后自动推进下一回合。
  state = failIfExtinct(state);
  if (state.gameOver) return state;
  const tile = state.tiles.get(tileKey);
  if (state.hasExpandedThisTurn) {
    return appendLog(state, `${state.currentMa} Ma：本回合已经开过一个格子，结束回合后才能继续。`);
  }

  if (!canExpandTo(state, tile)) {
    return appendLog(state, `${state.currentMa} Ma：目标格子的战力或人口要求尚未满足。`);
  }

  const recapturedAiFactionId = tile.aiFactionId ?? null;
  const recaptureSummary = recapturedAiFactionId
    ? getAiDensityCaptureSummary(state, getAiFactionById(state, recapturedAiFactionId))
    : null;
  const populationCost = getExpansionPopulationCost(state, tile);
  const nextTiles = new Map(state.tiles);
  nextTiles.set(tileKey, {
    ...tile,
    owned: true,
    aiFactionId: null,
    revealed: true,
    scouted: false
  });

  const freeDromaeosaurExpansion =
    // 恐爪龙线每周期第一次扩张不消耗“本回合扩张次数”，允许连开第二格。
    hasAbility(state, "sickle_raid") && !state.cycleFreeExpansionUsed && (state.cycleExpansionCount ?? 0) === 0;

  let expandedState = removeExtinctAiFactions({
    ...state,
    tiles: nextTiles,
    aiFactions: recapturedAiFactionId
      ? (state.aiFactions ?? []).map((candidate) =>
          candidate.id === recapturedAiFactionId
            ? {
                ...candidate,
                population: Math.max(
                  0,
                  (candidate.population ?? AI_INITIAL_POPULATION) - getDefenderPopulationLoss(recaptureSummary.cost)
                )
              }
            : candidate
        )
      : state.aiFactions,
    population: state.population - populationCost,
    temporaryPowerBonus: getTemporaryPowerBonus(state) + (TERRAIN_TYPES[tile.terrain].temporaryCombatBonus ?? 0),
    activeCoord: { q: tile.q, r: tile.r },
    hasExpandedThisTurn: !freeDromaeosaurExpansion,
    cycleExpansionCount: (state.cycleExpansionCount ?? 0) + 1,
    cycleFreeExpansionUsed: state.cycleFreeExpansionUsed || freeDromaeosaurExpansion
  });

  expandedState = ensureVisibleTilesForState(expandedState);
  let glideRevealCount = 0;
  if (hasAbility(expandedState, "glide_spread")) {
    const beforeRevealCount = expandedState.extraRevealedKeys?.length ?? 0;
    expandedState = revealSecondRingTiles(expandedState, tile, 2);
    glideRevealCount = Math.max(0, (expandedState.extraRevealedKeys?.length ?? 0) - beforeRevealCount);
  }

  const glideSummary = glideRevealCount > 0 ? `，滑翔扩散额外揭示 ${glideRevealCount} 格` : "";
  const logMessage = recaptureSummary
    ? `${state.currentMa} Ma：收复${tileLabel(tile)}，消耗 ${populationCost} 人口，敌群损失 ${getDefenderPopulationLoss(recaptureSummary.cost)}（${formatAiPopulationFormula(recaptureSummary)}）${glideSummary}。`
    : `${state.currentMa} Ma：占领${tileLabel(tile)}，消耗 ${populationCost} 人口${glideSummary}。`;

  return failIfExtinct(appendLog(expandedState, logMessage));
}

export function resolveExpandedTurnState(expandedState) {
  // 扩张次数真正用完后才推进 Ma；镰爪突袭的免费扩张会停留在当前 Ma。
  return expandedState.hasExpandedThisTurn ? advanceTurn(expandedState) : expandedState;
}

export function advanceTurn(state) {
  // 回合推进总流程：
  // 1. 检查灭绝和栖息地切断；2. 时间前进并增长人口；3. 处理历史灾变和周期事件；
  // 4. 刷新/成长/行动 AI；5. 刷新可见地图。
  if (state.gameOver) {
    return state;
  }
  state = failIfExtinct(state);
  if (state.gameOver || state.pendingMutationChoice) {
    return state;
  }
  state = removeExtinctAiFactions(state);
  state = applyHabitatCutoffPenalty(state);
  state = applyAiHabitatCutoffPenalties(state);
  state = failIfExtinct(state);
  if (state.gameOver) {
    return state;
  }

  const nextTurn = Math.min(MAX_TURNS, state.turn + 1);
  const nextMa = Math.max(END_MA, state.currentMa - 1);
  const growth = getPopulationGrowth(state).totalGrowth;
  let nextState = {
    ...state,
    turn: nextTurn,
    currentMa: nextMa,
    population: state.population + growth,
    hasExpandedThisTurn: false
  };

  nextState = appendLog(nextState, `${nextMa} Ma：人口增加 ${growth}，当前人口 ${nextState.population}。`);
  nextState = applyMassExtinctions(nextState, state.currentMa, nextMa);
  nextState = failIfExtinct(nextState);
  if (nextState.gameOver) {
    return nextState;
  }

  if (nextTurn >= MAX_TURNS || nextMa <= END_MA) {
    // 到 66 Ma 时触发陨石终局判定。
    const result = checkVictory(nextState);
    return appendLog(
      {
        ...nextState,
        gameOver: true,
        pendingMutationChoice: false,
        mutationChoices: [],
        result
      },
      `66 Ma：陨石事件触发，${result.title}。`
    );
  }

  nextState = applySparsePopulationTerritoryLoss(nextState);
  nextState = failIfExtinct(nextState);
  if (nextState.gameOver) {
    return nextState;
  }

  if (nextTurn % 5 === 1) {
    // 周期开始：发放变异点并生成本周期 4 选 1。
    const mutationPointGain = getCycleMutationPointGain(nextState);
    const choiceState = {
      ...nextState,
      temporaryPowerBonus: 0,
      cycleExpansionCount: 0,
      cycleFreeExpansionUsed: false,
      mutationPoints: (nextState.mutationPoints ?? 0) + mutationPointGain
    };
    nextState = appendLog(
      {
        ...choiceState,
        pendingMutationChoice: true,
        mutationChoices: generateMutationChoices(choiceState)
      },
      `${nextMa} Ma：新的 5Ma 周期开始，获得 ${mutationPointGain} 个异变点并出现 4 个稳定异变选项。`
    );
  }

  if (nextTurn % 5 === 3) {
    // 周期第三年：触发一次随机事件。
    nextState = applyRandomEventNotice(nextState);
    nextState = failIfExtinct(nextState);
    if (nextState.gameOver) {
      return nextState;
    }
  }

  nextState = spawnAiFactionIfNeeded(nextState);
  nextState = advanceAiCycleGrowth(nextState);
  const aiAveragePopulationBeforeGrowthByFaction = getAiAveragePopulationByFaction(nextState);
  nextState = growAiFactions(nextState);
  nextState = runAiTurns(nextState, aiAveragePopulationBeforeGrowthByFaction);
  nextState = failIfExtinct(nextState);

  return ensureVisibleTilesForState(nextState);
}

export function tileLabel(tile) {
  // 日志使用的简短坐标标签。
  if (!tile) return "未知格子";
  return `(${tile.q}, ${tile.r})`;
}

// ── 教程地形准备（纯状态转换，由 UI 层按需调用） ──

export const TUTORIAL_GRASSLAND_REQUIREMENT = 1;
export const TUTORIAL_GRASSLAND_COST = 6;

export function getTutorialTerrainCandidates(state) {
  return (state.visibleKeys ?? [])
    .map((key) => state.tiles.get(key))
    .filter((tile) => tile?.revealed && !tile.owned && tile.conquerable !== false && !tile.aiFactionId)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function setTutorialTerrain(nextTiles, key, terrainId, state) {
  const tile = nextTiles.get(key);
  if (!tile) return;
  const terrain = TERRAIN_TYPES[terrainId];
  const generatedTurn = state.turn;
  const random = mulberry32(coordinateSeed(state.seed, tile, generatedTurn, state.terrainEpoch ?? 0));
  nextTiles.set(key, {
    ...tile,
    terrain: terrainId,
    combatRequired: generateTileCombatRequirement(generatedTurn, terrainId, random),
    populationCost: generateTilePopulationCost(generatedTurn, terrainId, random),
    populationMultiplierDelta: terrain.populationMultiplierDelta,
    combatBonus: terrain.combatBonus,
    conquerable: terrain.conquerable,
    revealed: true,
    scouted: false,
    generatedTurn
  });
}

export function prepareTutorialGrassland(state) {
  const targetKey = findTutorialGrasslandKey(state) ?? (state.visibleKeys ?? []).find((key) => key !== "0,0");
  const tile = targetKey ? state.tiles.get(targetKey) : null;
  if (!targetKey || !tile) return state;

  const terrain = TERRAIN_TYPES.grassland;
  const nextTiles = new Map(state.tiles);
  nextTiles.set(targetKey, {
    ...tile,
    terrain: "grassland",
    combatRequired: TUTORIAL_GRASSLAND_REQUIREMENT,
    populationCost: TUTORIAL_GRASSLAND_COST,
    populationMultiplierDelta: terrain.populationMultiplierDelta,
    combatBonus: terrain.combatBonus,
    conquerable: terrain.conquerable,
    revealed: true,
    scouted: false,
    aiFactionId: null
  });

  return {
    ...state,
    tiles: nextTiles
  };
}

export function findTutorialGrasslandKey(state) {
  const candidates = getTutorialTerrainCandidates(state);
  return (
    candidates
      .filter((tile) => tile.conquerable !== false && !tile.aiFactionId)
      .sort((left, right) => {
        // 选离原点最近的格子作为教程湿地目标
        const leftDist = Math.abs(left.q) + Math.abs(left.r);
        const rightDist = Math.abs(right.q) + Math.abs(right.r);
        return leftDist - rightDist;
      })[0]?.key ?? null
  );
}

export function prepareSecondExpansionTerrain(state) {
  const candidates = getTutorialTerrainCandidates(state);
  if (candidates.length === 0) return state;

  const nextTiles = new Map(state.tiles);
  const usedKeys = new Set();
  const existingForest = candidates.find((tile) => tile.terrain === "forest");
  const forestKey = existingForest?.key ?? candidates[0]?.key ?? null;
  if (forestKey) {
    setTutorialTerrain(nextTiles, forestKey, "forest", state);
    usedKeys.add(forestKey);
  }

  const existingDesert = candidates.find((tile) => tile.terrain === "desert" && !usedKeys.has(tile.key));
  const desertKey = existingDesert?.key ?? candidates.find((tile) => !usedKeys.has(tile.key))?.key ?? null;
  if (desertKey) {
    setTutorialTerrain(nextTiles, desertKey, "desert", state);
  }

  return {
    ...state,
    tiles: nextTiles
  };
}

export function findSecondExpansionTerrainTargets(state) {
  const candidates = getTutorialTerrainCandidates(state);
  return {
    forest: candidates.find((tile) => tile.terrain === "forest" && canExpandTo(state, tile))?.key ?? null,
    desert: candidates.find((tile) => tile.terrain === "desert" && canExpandTo(state, tile))?.key ?? null
  };
}
