import { TERRAIN_TYPES, TERRAIN_WEIGHTS } from "./config.js";

// 六边形地图使用 axial 坐标系：
// q 表示斜向列，r 表示行；第三个隐含轴为 -q-r。
// 这种坐标系适合计算相邻格、距离和环形范围。
export const HEX_DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
];

export function coordKey(coord) {
  // Map 的 key 统一使用 "q,r"，这样状态里可以稳定定位同一格子。
  return `${coord.q},${coord.r}`;
}

export function parseCoordKey(key) {
  const [q, r] = key.split(",").map(Number);
  return { q, r };
}

export function getNeighbors(coord) {
  // 返回固定顺序的六个相邻坐标；AI 和可见边界都依赖这个顺序保持稳定。
  return HEX_DIRECTIONS.map((direction) => ({
    q: coord.q + direction.q,
    r: coord.r + direction.r
  }));
}

export function mulberry32(seed) {
  // 一个轻量、可复现的伪随机数生成器。
  // 同一 seed 会生成同一串结果，方便地图和事件在测试里保持确定性。
  return function nextRandom() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function coordinateSeed(seed, coord, turn, terrainEpoch = 0) {
  // 将全局 seed、坐标和生成回合混合成单个无符号整数。
  // 这样同一坐标在同一时间点生成出的地形和数值是稳定的。
  let value = seed ^ Math.imul(coord.q + 1019, 374761393) ^ Math.imul(coord.r + 9176, 668265263);
  value ^= Math.imul(turn + 31, 2246822519);
  if (terrainEpoch > 0) {
    value ^= Math.imul(terrainEpoch, 3266489917);
  }
  return value >>> 0;
}

function randomInt(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

export function weightedTerrain(random, weights = TERRAIN_WEIGHTS) {
  // 按 TERRAIN_WEIGHTS 抽取地形；如果浮点累加边界没命中，则兜底返回最后一项。
  const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);
  const roll = random() * totalWeight;
  let cursor = 0;
  for (const [terrain, weight] of weights) {
    cursor += weight;
    if (roll <= cursor) {
      return terrain;
    }
  }
  return weights[weights.length - 1][0];
}

export function getEra(turn) {
  const ma = 252 - turn;
  if (ma >= 201) return "三叠纪";
  if (ma >= 145) return "侏罗纪";
  return "白垩纪";
}

export function getCombatRequirementPressure(turn) {
  return Math.floor(turn / 15);
}

export function getPopulationCostPressure(turn) {
  return Math.floor(turn / 10);
}

export function generateTileCombatRequirement(turn, terrainId, random) {
  // 时间越接近白垩纪末，基础环境压力越高，格子的战力要求随之抬升。
  // 地形修正用于表现湿地更容易、沙漠更困难等差异。
  const terrain = TERRAIN_TYPES[terrainId];
  const timePressure = getCombatRequirementPressure(turn);
  const randomMin = 1 + Math.floor(turn / 75);
  const randomMax = 3 + Math.floor(turn / 36);
  return Math.max(1, randomInt(random, randomMin, randomMax) + timePressure + terrain.combatModifier);
}

export function generateTilePopulationCost(turn, terrainId, random) {
  // 人口消耗同样随时间增加；地形修正用于表现不同栖息地的扩张成本。
  const terrain = TERRAIN_TYPES[terrainId];
  const timeCost = getPopulationCostPressure(turn);
  return Math.max(3, randomInt(random, 5, 10) + timeCost + terrain.populationCostModifier);
}

export function createTile(coord, turn, seed, owned = false, terrainEpoch = 0) {
  // 起源格永远固定为可占领、已揭示、已拥有，避免开局随机性破坏基本状态。
  if (coord.q === 0 && coord.r === 0) {
    return {
      key: coordKey(coord),
      q: coord.q,
      r: coord.r,
      terrain: "origin",
      combatRequired: 0,
      populationCost: 0,
      populationMultiplierDelta: 0,
      combatBonus: 0,
      conquerable: true,
      revealed: true,
      owned: true,
      generatedTurn: turn
    };
  }

  // 普通格只在第一次需要时生成并写入 state.tiles。
  // 后续读取同一格会复用已存储对象，不会因为回合变化重新掷骰。
  const random = mulberry32(coordinateSeed(seed, coord, turn, terrainEpoch));
  const terrain = weightedTerrain(random);
  const terrainConfig = TERRAIN_TYPES[terrain];
  return {
    key: coordKey(coord),
    q: coord.q,
    r: coord.r,
    terrain,
    combatRequired: terrainConfig.conquerable ? generateTileCombatRequirement(turn, terrain, random) : 0,
    populationCost: terrainConfig.conquerable ? generateTilePopulationCost(turn, terrain, random) : 0,
    populationMultiplierDelta: terrainConfig.populationMultiplierDelta,
    combatBonus: terrainConfig.combatBonus,
    conquerable: terrainConfig.conquerable,
    revealed: true,
    owned,
    generatedTurn: turn
  };
}

export function visibleNeighborKeysFrom(coord, ownedKeys) {
  return getNeighbors(coord)
    .map(coordKey)
    .filter((key) => !ownedKeys.has(key))
    .slice(0, 6);
}

export function computeVisibleKeys(ownedKeys) {
  // 可见边界由所有已拥有格子的外圈组成，已拥有格自身不会出现在 visibleKeys 中。
  const visibleKeys = [];
  for (const ownedKey of ownedKeys) {
    for (const neighbor of getNeighbors(parseCoordKey(ownedKey))) {
      const key = coordKey(neighbor);
      if (!ownedKeys.has(key) && !visibleKeys.includes(key)) {
        visibleKeys.push(key);
      }
    }
  }

  return visibleKeys;
}

function addGeneratedTile(nextTiles, key, state) {
  // 惰性补全地图：只有进入视野/侦察/天眼等流程的格子才会实际创建。
  if (!nextTiles.has(key)) {
    nextTiles.set(key, createTile(parseCoordKey(key), state.turn, state.seed, false, state.terrainEpoch ?? 0));
  }
}

function addUnique(list, key) {
  if (!list.includes(key)) list.push(key);
}

export function resetPlayerRevealedTiles(state) {
  const nextTiles = new Map();

  for (const [key, tile] of state.tiles) {
    nextTiles.set(key, {
      ...tile,
      revealed: Boolean(tile.owned),
      scouted: false
    });
  }

  return {
    ...state,
    tiles: nextTiles,
    visibleKeys: [],
    scoutedKeys: [],
    extraRevealedKeys: []
  };
}

export function ensureVisibleTiles(state, options = {}) {
  // 这是地图可见性规则的中心函数。
  // 它根据当前领地、特殊能力和额外揭示记录，更新 tiles / visibleKeys / scoutedKeys。
  const ownedKeys = new Set([...state.tiles.values()].filter((tile) => tile.owned).map((tile) => tile.key));
  const visibleKeys = computeVisibleKeys(ownedKeys);
  const nextTiles = new Map(state.tiles);

  for (const key of visibleKeys) {
    addGeneratedTile(nextTiles, key, state);
  }

  const scoutedKeys = [];

  if (options.waterPassage) {
    // 棘龙线的"涉水通道"：水域仍不可占领，但不会阻断视野继续向外延伸。
    // 水域背后的格子加入 scoutedKeys（可见但无法直接扩张），而非 visibleKeys。
    for (const key of [...visibleKeys]) {
      const tile = nextTiles.get(key);
      if (tile?.terrain !== "water") continue;
      for (const neighbor of getNeighbors(tile)) {
        const neighborKey = coordKey(neighbor);
        if (!ownedKeys.has(neighborKey)) {
          addUnique(scoutedKeys, neighborKey);
          addGeneratedTile(nextTiles, neighborKey, state);
        }
      }
    }
  }
  if (options.scoutOuterRing) {
    // 暴龙线的嗅觉追踪：额外显示边界外一圈，但这些格子仍需要先扩张到相邻边界。
    for (const key of visibleKeys) {
      const tile = nextTiles.get(key);
      if (!tile) continue;
      for (const neighbor of getNeighbors(tile)) {
        const neighborKey = coordKey(neighbor);
        if (!ownedKeys.has(neighborKey) && !visibleKeys.includes(neighborKey)) {
          addUnique(scoutedKeys, neighborKey);
          addGeneratedTile(nextTiles, neighborKey, state);
        }
      }
    }
  }

  const extraRevealedKeys = (state.extraRevealedKeys ?? []).filter((key) => !ownedKeys.has(key));
  for (const key of extraRevealedKeys) {
    addGeneratedTile(nextTiles, key, state);
  }

  for (const [key, tile] of nextTiles) {
    // revealed 控制地图上能否看见；scouted 控制“看见但暂不可直接占领”的样式和提示。
    if (!tile.owned) {
      const aiAdjacentToOwned = tile.aiFactionId
        ? getNeighbors(tile).some((neighbor) => ownedKeys.has(coordKey(neighbor)))
        : false;
      nextTiles.set(key, {
        ...tile,
        revealed:
          visibleKeys.includes(key) || scoutedKeys.includes(key) || extraRevealedKeys.includes(key) || aiAdjacentToOwned,
        scouted: scoutedKeys.includes(key) && !visibleKeys.includes(key)
      });
    }
  }

  return {
    ...state,
    tiles: nextTiles,
    visibleKeys,
    scoutedKeys,
    extraRevealedKeys
  };
}

export function revealSecondRingTiles(state, originCoord, count) {
  // 用于小盗龙滑翔、随机事件和类似“额外揭示”效果。
  // 它只揭示候选格，不改变可占领边界，因此不会绕过相邻扩张规则。
  const ownedKeys = new Set([...state.tiles.values()].filter((tile) => tile.owned).map((tile) => tile.key));
  const excludedKeys = new Set([
    ...ownedKeys,
    ...(state.visibleKeys ?? []),
    ...(state.scoutedKeys ?? []),
    ...(state.extraRevealedKeys ?? [])
  ]);
  const nextTiles = new Map(state.tiles);
  const extraRevealedKeys = [...(state.extraRevealedKeys ?? [])];
  const candidates = [];

  for (const neighbor of getNeighbors(originCoord)) {
    for (const secondRing of getNeighbors(neighbor)) {
      const key = coordKey(secondRing);
      if (!excludedKeys.has(key) && key !== coordKey(originCoord) && !candidates.includes(key)) {
        candidates.push(key);
      }
    }
  }

  for (const key of candidates.slice(0, count)) {
    addGeneratedTile(nextTiles, key, state);
    const tile = nextTiles.get(key);
    nextTiles.set(key, { ...tile, revealed: true, scouted: false });
    extraRevealedKeys.push(key);
  }

  return {
    ...state,
    tiles: nextTiles,
    extraRevealedKeys
  };
}
