export const SAVE_VERSION = 1;

const SAVE_KEY = "dinosaur-hex-evolution.save.v1";
const API_BASE = "/api/saves";

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidTileEntry(entry) {
  return Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && isObject(entry[1]);
}

function isValidStateShape(state) {
  return (
    isObject(state) &&
    Array.isArray(state.tiles) &&
    state.tiles.every(isValidTileEntry) &&
    Number.isInteger(state.seed) &&
    Number.isInteger(state.turn) &&
    Number.isFinite(state.currentMa)
  );
}

export function serializeState(state) {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    state: {
      ...state,
      tiles: [...state.tiles.entries()]
    }
  };
}

function normalizeLoadedState(raw) {
  // 补齐存档可能缺失的字段默认值，并修正 owned tile 的 revealed/scouted 一致性。
  // 通过 ...raw 先展开原始值，再覆盖需要修正的字段，确保未知属性不会被丢弃。
  const tiles = new Map(raw.tiles);
  for (const [, tile] of tiles) {
    if (tile.owned) {
      tile.revealed = true;
      tile.scouted = false;
    }
  }

  return {
    ...raw,
    seed: raw.seed >>> 0,
    turn: raw.turn ?? 0,
    currentMa: raw.currentMa ?? 252,
    tiles,
    population: raw.population ?? 100,
    basePower: raw.basePower ?? 1,
    reproduction: raw.reproduction ?? 5,
    mutationPoints: raw.mutationPoints ?? 0,
    unlockedMutationIds: raw.unlockedMutationIds ?? [],
    mutationAttributes: raw.mutationAttributes ?? {},
    aiFactions: raw.aiFactions ?? [],
    activeCoord: raw.activeCoord ?? { q: 0, r: 0 },
    visibleKeys: raw.visibleKeys ?? [],
    scoutedKeys: raw.scoutedKeys ?? [],
    log: raw.log ?? [],
    notice: raw.notice ?? null,
    gameOver: raw.gameOver ?? false,
    pendingMutationChoice: raw.pendingMutationChoice ?? false,
    mutationChoices: raw.mutationChoices ?? null,
    temporaryPowerBonus: raw.temporaryPowerBonus ?? 0,
    powerDamageSeek: raw.powerDamageSeek ?? 0,
    terrainEpoch: raw.terrainEpoch ?? 0,
    lastMassExtinctionTurn: raw.lastMassExtinctionTurn ?? 0,
    hasExpandedThisTurn: raw.hasExpandedThisTurn ?? false,
    cycleExpansionCount: raw.cycleExpansionCount ?? 0,
    cycleFreeExpansionUsed: raw.cycleFreeExpansionUsed ?? false,
    cycleMutationUsed: raw.cycleMutationUsed ?? false
  };
}

export function deserializeState(payload) {
  if (!isObject(payload) || payload.version !== SAVE_VERSION || !isValidStateShape(payload.state)) {
    return null;
  }

  return normalizeLoadedState(payload.state);
}

export function saveGame(state) {
  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.setItem(SAVE_KEY, JSON.stringify(serializeState(state)));
    return true;
  } catch {
    return false;
  }
}

export function loadGame() {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const rawSave = storage.getItem(SAVE_KEY);
    if (!rawSave) return null;
    return deserializeState(JSON.parse(rawSave));
  } catch {
    return null;
  }
}

export function hasSaveGame() {
  return loadGame() !== null;
}

export function clearSaveGame() {
  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ── 服务端存档 API ──────────────────────────────────────
// 异步函数：通过 Flask 后端存取游戏状态，localStorage 作为离线后备。

/**
 * 向服务端创建存档。成功时返回存档 id，失败时返回 null。
 */
export async function saveGameToServer(state) {
  try {
    const payload = serializeState(state);
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 从服务端读取最近的存档。无存档或网络不通时返回 null。
 */
export async function loadGameFromServer() {
  try {
    const res = await fetch(`${API_BASE}/latest`);
    if (!res.ok) return null;
    const payload = await res.json();
    return deserializeState(payload);
  } catch {
    return null;
  }
}

/**
 * 查询服务端是否有存档。网络不通时返回 false。
 */
export async function hasSaveGameOnServer() {
  try {
    const res = await fetch(API_BASE);
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.saves) && data.saves.length > 0;
  } catch {
    return false;
  }
}

/**
 * 删除服务端最近一次存档。返回是否成功。
 */
export async function clearLatestServerSave() {
  try {
    const listRes = await fetch(API_BASE);
    if (!listRes.ok) return false;
    const data = await listRes.json();
    const saves = data.saves ?? [];
    if (saves.length === 0) return true; // 没存档也算"清空成功"
    const latestId = saves[0].id;
    const delRes = await fetch(`${API_BASE}/${latestId}`, { method: "DELETE" });
    return delRes.ok;
  } catch {
    return false;
  }
}
