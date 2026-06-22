import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../src/gameState.js";
import {
  createTile,
  ensureVisibleTiles,
  generateTileCombatRequirement,
  generateTilePopulationCost,
  getNeighbors,
  mulberry32
} from "../src/map.js";
import { EVOLUTION_NODES, getAdvancedMutationNodes } from "../src/evolution.js";
import { resolveExpandedTurnState } from "../src/rules.js";
import { getRandomEventById, selectRandomEventRarity } from "../src/randomEvents.js";
import {
  advanceTurn,
  canExpandTo,
  canChooseMutation,
  checkVictory,
  chooseMutation,
  ensureVisibleTilesForState,
  expandToTile,
  generateMutationChoices,
  getAiFactionPower,
  getEffectiveCombatRequirement,
  getEffectivePopulationCost,
  getExpansionPopulationCost,
  getOwnedTiles,
  getPopulationGrowth,
  getPopulationMultiplier,
  getPowerVictoryTarget,
  getRecentTurnHistory,
  getTemporaryPowerBonus,
  getTilePowerBonus,
  getTotalPower,
  selectMassExtinctionSurvivorKeys
} from "../src/rules.js";

function testTile(overrides) {
  return {
    key: "1,0",
    q: 1,
    r: 0,
    terrain: "forest",
    combatRequired: 1,
    populationCost: 0,
    populationMultiplierDelta: 0,
    combatBonus: 0,
    conquerable: true,
    revealed: true,
    owned: false,
    ...overrides
  };
}

function withTiles(state, tiles) {
  return {
    ...state,
    tiles: new Map([...state.tiles, ...tiles.map((tile) => [tile.key, tile])]),
    visibleKeys: [...new Set([...(state.visibleKeys ?? []), ...tiles.map((tile) => tile.key)])]
  };
}

function blockedTile(key, q, r) {
  return testTile({ key, q, r, conquerable: false, populationCost: 0 });
}

function withMutations(state, ids) {
  return {
    ...state,
    unlockedMutationIds: ["primitive", ...ids],
    currentSpeciesId: ids.at(-1) ?? "primitive"
  };
}

function advanceMany(state, count) {
  let next = state;
  for (let index = 0; index < count; index += 1) {
    if (next.pendingMutationChoice) {
      next = chooseMutation(next, "basic_power");
    }
    next = advanceTurn(next);
  }
  return next;
}

function axialDistance(tile) {
  return (Math.abs(tile.q) + Math.abs(tile.r) + Math.abs(tile.q + tile.r)) / 2;
}

function hexDistance(left, right) {
  return axialDistance({ q: left.q - right.q, r: left.r - right.r });
}

function parseKey(key) {
  const [q, r] = key.split(",").map(Number);
  return { q, r };
}

function playerBoundaryCoords(state) {
  const ownedKeys = new Set(getOwnedTiles(state).map((tile) => tile.key));
  const boundaryKeys = new Set();

  for (const ownedTile of getOwnedTiles(state)) {
    for (const neighbor of getNeighbors(ownedTile)) {
      const key = `${neighbor.q},${neighbor.r}`;
      if (!ownedKeys.has(key)) {
        boundaryKeys.add(key);
      }
    }
  }

  return [...boundaryKeys].map(parseKey);
}

function minDistanceToPlayerBoundary(state, coord) {
  const distances = playerBoundaryCoords(state).map((boundary) => hexDistance(coord, boundary));
  return Math.min(...distances);
}

function withStaleVision(state) {
  const staleRevealed = testTile({ key: "8,0", q: 8, r: 0, revealed: true });
  const staleScouted = testTile({ key: "8,-1", q: 8, r: -1, revealed: true, scouted: true });
  return {
    ...state,
    tiles: new Map([
      ...state.tiles,
      [staleRevealed.key, staleRevealed],
      [staleScouted.key, staleScouted]
    ]),
    visibleKeys: [...new Set([...(state.visibleKeys ?? []), staleRevealed.key])],
    scoutedKeys: [...new Set([...(state.scoutedKeys ?? []), staleScouted.key])],
    extraRevealedKeys: [...new Set([...(state.extraRevealedKeys ?? []), staleRevealed.key])]
  };
}

function assertVisionResetToCurrentFrontier(state) {
  const ownedKeys = new Set(getOwnedTiles(state).map((tile) => tile.key));
  const expectedVisibleKeys = new Set();

  for (const tile of getOwnedTiles(state)) {
    for (const neighbor of getNeighbors(tile)) {
      const key = `${neighbor.q},${neighbor.r}`;
      if (!ownedKeys.has(key)) {
        expectedVisibleKeys.add(key);
      }
    }
  }

  assert.deepEqual(new Set(state.visibleKeys ?? []), expectedVisibleKeys);
  assert.deepEqual(state.scoutedKeys ?? [], []);
  assert.deepEqual(state.extraRevealedKeys ?? [], []);

  for (const tile of state.tiles.values()) {
    if (tile.owned) {
      assert.equal(tile.revealed, true);
    } else if (!expectedVisibleKeys.has(tile.key)) {
      assert.equal(tile.revealed, false);
      assert.equal(tile.scouted ?? false, false);
    }
  }
}

function ringTiles(minRadius, maxRadius, create) {
  const tiles = [];
  for (let q = -maxRadius; q <= maxRadius; q += 1) {
    for (let r = -maxRadius; r <= maxRadius; r += 1) {
      const distance = axialDistance({ q, r });
      if (distance >= minRadius && distance <= maxRadius) {
        tiles.push(create(`${q},${r}`, q, r));
      }
    }
  }
  return tiles;
}

function assertConnectedTiles(tiles) {
  if (tiles.length <= 1) return;
  const tileByKey = new Map(tiles.map((tile) => [tile.key, tile]));
  const visited = new Set([tiles[0].key]);
  const queue = [tiles[0]];

  for (let index = 0; index < queue.length; index += 1) {
    for (const neighbor of getNeighbors(queue[index])) {
      const key = `${neighbor.q},${neighbor.r}`;
      if (tileByKey.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push(tileByKey.get(key));
      }
    }
  }

  assert.equal(visited.size, tiles.length);
}

function withoutAi(state) {
  return {
    ...state,
    aiFactions: [],
    tiles: new Map([...state.tiles].filter(([, tile]) => !tile.aiFactionId))
  };
}

function applyEventById(eventId, state, seed = 1) {
  const event = getRandomEventById(eventId);
  assert.notEqual(event, null);
  return event.apply(state, mulberry32(seed)).state;
}

function applyEventResultById(eventId, state, seed = 1) {
  const event = getRandomEventById(eventId);
  assert.notEqual(event, null);
  return event.apply(state, mulberry32(seed));
}

test("createInitialState uses a runtime seed unless one is provided", () => {
  const originalRandom = Math.random;

  try {
    Math.random = () => 0.1;
    const first = createInitialState();
    Math.random = () => 0.2;
    const second = createInitialState();

    assert.equal(first.seed, Math.floor(0.1 * 0xffffffff) >>> 0);
    assert.equal(second.seed, Math.floor(0.2 * 0xffffffff) >>> 0);
    assert.notEqual(first.seed, second.seed);
    assert.equal(Number.isInteger(first.seed), true);
    assert.equal(Number.isInteger(second.seed), true);
  } finally {
    Math.random = originalRandom;
  }

  const fixed = createInitialState({ seed: 7429 });
  assert.equal(fixed.seed, 7429);
});

test("advanceTurn moves 1 Ma, adds population, and starts the first 5Ma cycle", () => {
  const state = createInitialState();
  const next = advanceTurn(state);

  assert.equal(next.turn, 1);
  assert.equal(next.currentMa, 251);
  assert.equal(next.population, 11);
  assert.equal(next.pendingMutationChoice, true);
  assert.equal(next.mutationPoints, 1);
  assert.equal(next.mutationChoices.length, 4);
  assert.deepEqual(next.mutationAttributes, { power: 0, agility: 0, adaptation: 0 });
});

test("light cluster increases population growth by thirty percent", () => {
  const state = withMutations(
    {
      ...createInitialState(),
      population: 10,
      reproduction: 10,
      hasExpandedThisTurn: true
    },
    ["coelophysis"]
  );
  const next = advanceTurn(state);

  assert.equal(next.population, 23);
  assert.equal(next.log.some((entry) => entry.includes("人口增加 13")), true);
});

test("fractional population multiplier bonuses are hidden until they stack to a whole point", () => {
  const grassland = testTile({ key: "1,0", q: 1, r: 0, terrain: "grassland", populationMultiplierDelta: 1, owned: true });
  const desert = testTile({ key: "2,0", q: 2, r: 0, terrain: "desert", populationMultiplierDelta: -1, owned: true });
  const hiddenHalfState = withTiles(
    withMutations(
      {
        ...withoutAi(createInitialState()),
        population: 10,
        reproduction: 3
      },
      ["desert_brood"]
    ),
    [grassland, desert]
  );
  const hiddenHalfNext = advanceTurn(hiddenHalfState);

  assert.equal(getPopulationMultiplier(hiddenHalfState), 1);
  assert.equal(hiddenHalfNext.population, 13);
  assert.equal(hiddenHalfNext.log.some((entry) => entry.includes("人口增加 3")), true);

  const secondGrassland = testTile({
    key: "3,0",
    q: 3,
    r: 0,
    terrain: "grassland",
    populationMultiplierDelta: 1,
    owned: true
  });
  const secondDesert = testTile({
    key: "4,0",
    q: 4,
    r: 0,
    terrain: "desert",
    populationMultiplierDelta: -1,
    owned: true
  });
  const stackedHalfState = withTiles(hiddenHalfState, [secondGrassland, secondDesert]);
  const stackedHalfNext = advanceTurn(stackedHalfState);

  assert.equal(getPopulationMultiplier(stackedHalfState), 2);
  assert.equal(stackedHalfNext.population, 16);
  assert.equal(stackedHalfNext.log.some((entry) => entry.includes("人口增加 6")), true);
});

test("cycle mutation choice can take a free basic stat upgrade", () => {
  let state = advanceTurn(createInitialState());

  state = chooseMutation(state, "basic_power");
  assert.equal(state.basePower, 2);
  assert.equal(state.pendingMutationChoice, false);
  assert.equal(state.mutationPoints, 1);

  state = advanceTurn(state);
  assert.equal(state.turn, 2);
  assert.equal(state.mutationPoints, 1);
});

test("each turn removes one territory when population is below twice owned territory", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "-1,0", q: -1, r: 0, owned: true }),
    testTile({ key: "0,1", q: 0, r: 1, owned: true }),
    testTile({ key: "0,-1", q: 0, r: -1, owned: true }),
    testTile({ key: "1,-1", q: 1, r: -1, owned: true }),
    testTile({ key: "-1,1", q: -1, r: 1, owned: true }),
    testTile({ key: "2,0", q: 2, r: 0, owned: true }),
    testTile({ key: "-2,0", q: -2, r: 0, owned: true }),
    testTile({ key: "0,2", q: 0, r: 2, owned: true })
  ];
  const state = withStaleVision(withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 1,
      currentMa: 251,
      population: 7,
      reproduction: 0
    },
    ownedTiles
  ));

  const next = advanceTurn(state);

  assert.equal(next.turn, 2);
  assert.equal(next.population, 7);
  assert.equal(getOwnedTiles(next).length, 9);
  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(next.notices[0].type, "population-density");
  assert.equal(next.notices[0].removedTileCount, 1);
  assert.equal(next.notices[0].threshold, 20);
  assertVisionResetToCurrentFrontier(next);
});

test("each turn does not show density notice when territory is stable", () => {
  const ownedTiles = [testTile({ key: "1,0", q: 1, r: 0, owned: true })];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 1,
      currentMa: 251,
      population: 4,
      reproduction: 0
    },
    ownedTiles
  );

  const next = advanceTurn(state);

  assert.equal(getOwnedTiles(next).length, 2);
  assert.equal((next.notices ?? []).some((notice) => notice.type === "population-density"), false);
});

test("connected territory does not create a habitat cutoff notice", () => {
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      population: 30,
      reproduction: 0
    },
    [testTile({ key: "1,0", q: 1, r: 0, owned: true })]
  );

  const next = advanceTurn(state);

  assert.equal(next.turn, 10);
  assert.equal(next.population, 30);
  assert.equal(getOwnedTiles(next).length, 2);
  assert.equal((next.notices ?? []).some((notice) => notice.type === "habitat-cutoff"), false);
});

test("habitat cutoff keeps the largest connected territory and removes isolated tiles before growth", () => {
  const state = withStaleVision(withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      population: 30,
      reproduction: 5
    },
    [
      testTile({ key: "1,0", q: 1, r: 0, owned: true }),
      testTile({ key: "4,0", q: 4, r: 0, owned: true })
    ]
  ));

  const next = advanceTurn(state);

  assert.equal(next.turn, 10);
  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(next.tiles.get("1,0").owned, true);
  assert.equal(next.tiles.get("4,0").owned, false);
  assert.equal(next.population, 25);
  assert.equal(next.notices[0].type, "habitat-cutoff");
  assert.equal(next.notices[0].removedTileCount, 1);
  assert.equal(next.notices[0].populationLoss, 10);
  assert.equal(next.notices[0].populationBefore, 30);
  assert.equal(next.notices[0].populationAfter, 20);
  assertVisionResetToCurrentFrontier(next);
});

test("habitat cutoff tie keeps the origin component", () => {
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      population: 20,
      reproduction: 0
    },
    [testTile({ key: "3,0", q: 3, r: 0, owned: true })]
  );

  const next = advanceTurn(state);

  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(next.tiles.get("3,0").owned, false);
  assert.equal(next.population, 10);
  assert.equal(next.notices[0].type, "habitat-cutoff");
});

test("habitat cutoff tie without origin keeps the stable first component", () => {
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      population: 30,
      reproduction: 0,
      activeCoord: { q: 2, r: 0 }
    },
    [
      testTile({ key: "0,0", q: 0, r: 0, owned: false, revealed: false, scouted: false }),
      testTile({ key: "2,0", q: 2, r: 0, owned: true }),
      testTile({ key: "4,0", q: 4, r: 0, owned: true })
    ]
  );

  const next = advanceTurn(state);

  assert.equal(next.tiles.get("0,0").owned, false);
  assert.equal(next.tiles.get("2,0").owned, true);
  assert.equal(next.tiles.get("4,0").owned, false);
  assert.equal(next.population, 15);
  assert.deepEqual(next.activeCoord, { q: 2, r: 0 });
});

test("habitat cutoff population loss can trigger extinction before turn growth", () => {
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      population: 1,
      reproduction: 10
    },
    [testTile({ key: "3,0", q: 3, r: 0, owned: true })]
  );

  const next = advanceTurn(state);

  assert.equal(next.turn, 9);
  assert.equal(next.population, 0);
  assert.equal(next.gameOver, true);
  assert.equal(next.result.type, "extinction");
});

test("extinction result keeps the last two turn histories with population changes", () => {
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      population: 1,
      reproduction: 10,
      lastLoggedPopulation: 1
    },
    [testTile({ key: "3,0", q: 3, r: 0, owned: true })]
  );

  const next = advanceTurn(state);
  const [latest] = getRecentTurnHistory(next, 2);

  assert.equal(next.gameOver, true);
  assert.equal(latest.ma, 243);
  assert.equal(latest.populationBefore, 1);
  assert.equal(latest.populationAfter, 0);
  assert.equal(latest.populationDelta, -1);
  assert.equal(latest.events.length >= 2, true);
  assert.equal(next.result.type, "extinction");
});

test("habitat cutoff resolves when an AI-held separator split territory on the previous turn", () => {
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      population: 30,
      reproduction: 0,
      aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 1, originKey: "1,0", population: 1, basePower: 0 }]
    },
    [
      testTile({ key: "1,0", q: 1, r: 0, owned: false, aiFactionId: 1, revealed: true }),
      testTile({ key: "2,0", q: 2, r: 0, owned: true })
    ]
  );

  const next = advanceTurn(state);

  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(next.tiles.get("1,0").aiFactionId, 1);
  assert.equal(next.tiles.get("2,0").owned, false);
  assert.equal(next.population, 15);
  assert.equal(next.notices[0].type, "habitat-cutoff");
});

test("connected AI territory does not lose tiles or population to habitat cutoff", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 99, originKey: "4,0", population: 30, basePower: 0 };
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      reproduction: 0,
      aiFactions: [faction]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
      testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1 })
    ]
  );

  const next = advanceTurn(state);

  assert.equal(next.tiles.get("4,0").aiFactionId, 1);
  assert.equal(next.tiles.get("5,0").aiFactionId, 1);
  assert.equal(next.aiFactions[0].population, 30);
  assert.equal((next.notices ?? []).some((notice) => notice.type === "habitat-cutoff"), false);
});

test("AI habitat cutoff keeps the largest connected territory and removes isolated AI tiles", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 99, originKey: "4,0", population: 30, basePower: 0 };
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      reproduction: 0,
      aiFactions: [faction]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
      testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1 }),
      testTile({ key: "8,0", q: 8, r: 0, aiFactionId: 1 })
    ]
  );

  const next = advanceTurn(state);

  assert.equal(next.tiles.get("4,0").aiFactionId, 1);
  assert.equal(next.tiles.get("5,0").aiFactionId, 1);
  assert.equal(next.tiles.get("8,0").aiFactionId, null);
  assert.equal(next.aiFactions[0].population, 20);
  assert.equal((next.notices ?? []).some((notice) => notice.type === "habitat-cutoff"), false);
  assert.equal(next.log.some((entry) => entry.includes("敌群 #1 栖息地被切断")), true);
});

test("AI habitat cutoff tie keeps the stable first component", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 99, originKey: "8,0", population: 30, basePower: 0 };
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      reproduction: 0,
      aiFactions: [faction]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
      testTile({ key: "8,0", q: 8, r: 0, aiFactionId: 1 })
    ]
  );

  const next = advanceTurn(state);

  assert.equal(next.tiles.get("4,0").aiFactionId, 1);
  assert.equal(next.tiles.get("8,0").aiFactionId, null);
  assert.equal(next.aiFactions[0].population, 15);
});

test("cycle third turn applies a random event notice", () => {
  const state = {
    ...withoutAi(createInitialState()),
    turn: 2,
    currentMa: 250,
    population: 10,
    reproduction: 0
  };

  const next = advanceTurn(state);

  assert.equal(next.turn, 3);
  assert.equal(next.notices[0].type, "random-event");
  assert.equal(typeof next.notices[0].eventId, "string");
  assert.equal(["common", "rare", "legendary"].includes(next.notices[0].rarity), true);
  assert.equal(typeof next.notices[0].effectSummary, "string");
  assert.equal(typeof next.notices[0].message, "string");
  assert.equal(next.notices[0].message.length > 0, true);
  assert.equal(next.population > 0, true);
});

test("random event rarity uses 60/30/10 roll boundaries", () => {
  assert.equal(selectRandomEventRarity(0).id, "common");
  assert.equal(selectRandomEventRarity(59).id, "common");
  assert.equal(selectRandomEventRarity(60).id, "rare");
  assert.equal(selectRandomEventRarity(89).id, "rare");
  assert.equal(selectRandomEventRarity(90).id, "legendary");
  assert.equal(selectRandomEventRarity(99).id, "legendary");
});

test("negative random events clamp population and temporary power", () => {
  const failedHunt = applyEventById("failed_hunt", {
    ...withoutAi(createInitialState()),
    temporaryPowerBonus: 0
  });
  assert.equal(failedHunt.temporaryPowerBonus, 0);
});

test("random territory loss protects the origin tile", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "-1,0", q: -1, r: 0, owned: true }),
    testTile({ key: "0,1", q: 0, r: 1, owned: true })
  ];
  const state = withTiles(withoutAi(createInitialState()), ownedTiles);

  const next = applyEventById("habitat_collapse", state);

  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(getOwnedTiles(next).length, 2);
});

test("enemy bloom increases all AI populations", () => {
  const state = {
    ...withoutAi(createInitialState()),
    aiFactions: [
      { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 10 },
      { id: 2, waveIndex: 1, spawnTurn: 20, originKey: "-4,0", population: 1 }
    ]
  };

  const next = applyEventById("enemy_bloom", state);

  assert.equal(next.aiFactions[0].population, 13);
  assert.equal(next.aiFactions[1].population, 4);
});

test("common enemy food shortage reduces all AI populations", () => {
  const state = {
    ...withoutAi(createInitialState()),
    aiFactions: [
      { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 10 },
      { id: 2, waveIndex: 1, spawnTurn: 20, originKey: "-4,0", population: 1 },
      { id: 3, waveIndex: 1, spawnTurn: 20, originKey: "0,4", population: 0 }
    ]
  };

  const result = applyEventResultById("enemy_food_shortage", state);

  assert.equal(result.state.aiFactions[0].population, 8);
  assert.equal(result.state.aiFactions[1].population, 0);
  assert.equal(result.state.aiFactions[2].population, 0);
  assert.equal(result.effectSummary, "所有敌群人口 -3");
});

test("AI-only negative random events do nothing when no AI exists", () => {
  const state = { ...withoutAi(createInitialState()), population: 12, basePower: 3 };

  for (const eventId of ["enemy_food_shortage", "rival_infighting", "enemy_power_decay"]) {
    const result = applyEventResultById(eventId, state);

    assert.equal(result.state, state);
    assert.equal(result.state.population, 12);
    assert.deepEqual(result.state.aiFactions, []);
    assert.equal(result.effectSummary, "没有敌群受到影响");
  }
});

test("rival infighting reduces all AI populations", () => {
  const state = {
    ...withoutAi(createInitialState()),
    population: 12,
    aiFactions: [
      { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 20 },
      { id: 2, waveIndex: 1, spawnTurn: 20, originKey: "-4,0", population: 3 }
    ]
  };

  const result = applyEventResultById("rival_infighting", state);

  assert.equal(result.state.population, 12);
  assert.equal(result.state.aiFactions[0].population, 15);
  assert.equal(result.state.aiFactions[1].population, 2);
  assert.equal(result.effectSummary, "所有敌群人口 -6");
});

test("enemy power decay reduces all AI base power without going below zero", () => {
  const state = {
    ...withoutAi(createInitialState()),
    aiFactions: [
      { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 10, basePower: 3 },
      { id: 2, waveIndex: 1, spawnTurn: 20, originKey: "-4,0", population: 10, basePower: 0 },
      { id: 3, waveIndex: 1, spawnTurn: 20, originKey: "0,4", population: 10 }
    ]
  };

  const result = applyEventResultById("enemy_power_decay", state);

  assert.equal(result.state.aiFactions[0].basePower, 2);
  assert.equal(result.state.aiFactions[1].basePower, 0);
  assert.equal(result.state.aiFactions[2].basePower, 0);
  assert.equal(result.effectSummary, "所有敌群基础战力 -2");
});

test("rare terrain random events convert generated desert and grassland tiles", () => {
  const desert = testTile({ key: "1,0", q: 1, r: 0, terrain: "desert", combatBonus: 1, owned: true });
  const grassland = testTile({
    key: "2,0",
    q: 2,
    r: 0,
    terrain: "grassland",
    populationMultiplierDelta: 1,
    owned: true
  });
  const state = withTiles(withoutAi(createInitialState()), [desert, grassland]);

  const wetState = applyEventById("desert_to_grassland", state);
  assert.equal(wetState.tiles.get("1,0").terrain, "grassland");
  assert.equal(wetState.tiles.get("1,0").combatBonus, 0);
  assert.equal(wetState.tiles.get("1,0").populationMultiplierDelta, 1);
  assert.equal(wetState.tiles.get("1,0").owned, true);

  const dryState = applyEventById("grassland_to_desert", state);
  assert.equal(dryState.tiles.get("2,0").terrain, "desert");
  assert.equal(dryState.tiles.get("2,0").combatBonus, 1);
  assert.equal(dryState.tiles.get("2,0").populationMultiplierDelta, -1);
  assert.equal(dryState.tiles.get("2,0").owned, true);
});

test("legendary terrain random events clear ownership for blocked terrain", () => {
  const desert = testTile({ key: "1,0", q: 1, r: 0, terrain: "desert", combatBonus: 1, owned: true });
  const grassland = testTile({
    key: "2,0",
    q: 2,
    r: 0,
    terrain: "grassland",
    populationMultiplierDelta: 1,
    aiFactionId: 1
  });
  const state = withStaleVision(withTiles(
    {
      ...withoutAi(createInitialState()),
      aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "2,0", population: 12 }]
    },
    [desert, grassland]
  ));

  const flooded = applyEventById("desert_to_water", state);
  assert.equal(flooded.tiles.get("1,0").terrain, "water");
  assert.equal(flooded.tiles.get("1,0").conquerable, false);
  assert.equal(flooded.tiles.get("1,0").owned, false);
  assertVisionResetToCurrentFrontier(flooded);

  const raised = applyEventById("grassland_to_mountain", state);
  assert.equal(raised.tiles.get("2,0").terrain, "mountain");
  assert.equal(raised.tiles.get("2,0").conquerable, false);
  assert.equal(raised.tiles.get("2,0").aiFactionId, null);
});

test("legendary terrain random events can restore blocked terrain to conquerable terrain", () => {
  const water = testTile({ key: "1,0", q: 1, r: 0, terrain: "water", conquerable: false });
  const mountain = testTile({ key: "2,0", q: 2, r: 0, terrain: "mountain", conquerable: false });
  const state = withTiles(withoutAi(createInitialState()), [water, mountain]);

  const wetState = applyEventById("water_to_grassland", state);
  assert.equal(wetState.tiles.get("1,0").terrain, "grassland");
  assert.equal(wetState.tiles.get("1,0").conquerable, true);
  assert.equal(wetState.tiles.get("1,0").populationMultiplierDelta, 1);
  assert.equal(wetState.tiles.get("1,0").combatBonus, 0);

  const dryState = applyEventById("mountain_to_desert", state);
  assert.equal(dryState.tiles.get("2,0").terrain, "desert");
  assert.equal(dryState.tiles.get("2,0").conquerable, true);
  assert.equal(dryState.tiles.get("2,0").populationMultiplierDelta, -1);
  assert.equal(dryState.tiles.get("2,0").combatBonus, 1);
});

test("ecosystem collapse removes half of player and AI territory", () => {
  const playerTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "-1,0", q: -1, r: 0, owned: true }),
    testTile({ key: "0,1", q: 0, r: 1, owned: true }),
    testTile({ key: "0,-1", q: 0, r: -1, owned: true })
  ];
  const aiTiles = [
    testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
    testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1 }),
    testTile({ key: "4,1", q: 4, r: 1, aiFactionId: 1 }),
    testTile({ key: "5,-1", q: 5, r: -1, aiFactionId: 1 })
  ];
  const state = withStaleVision(withTiles(
    {
      ...withoutAi(createInitialState()),
      aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 12 }]
    },
    [...playerTiles, ...aiTiles]
  ));

  const next = applyEventById("ecosystem_collapse", state);
  const aiTileCount = [...next.tiles.values()].filter((tile) => tile.aiFactionId === 1).length;

  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(getOwnedTiles(next).length, 3);
  assert.equal(aiTileCount, 2);
  assertVisionResetToCurrentFrontier(next);
});

test("population reaching zero immediately ends in extinction failure", () => {
  const state = {
    ...withoutAi(createInitialState()),
    population: 0
  };

  const next = advanceTurn(state);

  assert.equal(next.population, 0);
  assert.equal(next.gameOver, true);
  assert.equal(next.pendingMutationChoice, false);
  assert.equal(next.result.type, "extinction");
});

test("territory reaching zero immediately ends in extinction failure", () => {
  const state = withoutAi(createInitialState());
  const origin = state.tiles.get("0,0");
  const next = advanceTurn({
    ...state,
    tiles: new Map([["0,0", { ...origin, owned: false, revealed: false, scouted: false }]]),
    visibleKeys: [],
    population: 10
  });

  assert.equal(next.population, 10);
  assert.equal(getOwnedTiles(next).length, 0);
  assert.equal(next.gameOver, true);
  assert.equal(next.pendingMutationChoice, false);
  assert.equal(next.result.type, "extinction");
});

test("mass extinction triggers after Triassic and keeps rounded population-based original territory", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "-1,0", q: -1, r: 0, owned: true }),
    testTile({ key: "0,1", q: 0, r: 1, owned: true }),
    testTile({ key: "0,-1", q: 0, r: -1, owned: true }),
    testTile({ key: "1,-1", q: 1, r: -1, owned: true })
  ];
  const state = withStaleVision(withTiles(
    {
      ...createInitialState({ seed: 7429 }),
      turn: 51,
      currentMa: 201,
      reproduction: 0,
      population: 100
    },
    ownedTiles
  ));

  const next = advanceTurn(state);

  assert.equal(next.currentMa, 200);
  assert.equal(next.population, 10);
  assert.equal(getOwnedTiles(next).length, 5);
  assert.equal(next.notices[0].tilesBefore, 6);
  assert.equal(next.notices[0].tilesAfter, 5);
  assert.equal(next.notices[0].removedTileCount, 1);
  assert.equal(next.notices[0].type, "mass-extinction");
  assert.equal(next.tiles.get(`${next.activeCoord.q},${next.activeCoord.r}`).owned, true);
  assert.equal(next.terrainEpoch, 1);
  assertConnectedTiles(getOwnedTiles(next));
  assertVisionResetToCurrentFrontier(next);
});

test("mass extinction survivor key selection stays connected and caps to largest component", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "2,0", q: 2, r: 0, owned: true }),
    testTile({ key: "8,0", q: 8, r: 0, owned: true }),
    testTile({ key: "9,0", q: 9, r: 0, owned: true }),
    testTile({ key: "10,0", q: 10, r: 0, owned: true })
  ];
  const survivorKeys = selectMassExtinctionSurvivorKeys(ownedTiles, 500, mulberry32(99));
  const survivors = ownedTiles.filter((tile) => survivorKeys.has(tile.key));

  assert.equal(survivors.length, 3);
  assertConnectedTiles(survivors);
});

test("mass extinction survivor key selection caps high population to ten connected tiles", () => {
  const ownedTiles = Array.from({ length: 12 }, (_, index) =>
    testTile({ key: `${index},0`, q: index, r: 0, owned: true })
  );
  const survivorKeys = selectMassExtinctionSurvivorKeys(ownedTiles, 500, mulberry32(99));
  const survivors = ownedTiles.filter((tile) => survivorKeys.has(tile.key));

  assert.equal(survivors.length, 10);
  assertConnectedTiles(survivors);
});

test("mass extinction also applies rounded population-based survival to all AI factions", () => {
  const aiFactions = [
    { id: 1, waveIndex: 1, spawnTurn: 52, originKey: "4,0", population: 50, basePower: 1 },
    { id: 2, waveIndex: 1, spawnTurn: 52, originKey: "-4,0", population: 7, basePower: 1 }
  ];
  const aiTiles = [
    testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
    testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1 }),
    testTile({ key: "5,-1", q: 5, r: -1, aiFactionId: 1 }),
    testTile({ key: "4,1", q: 4, r: 1, aiFactionId: 1 }),
    testTile({ key: "-4,0", q: -4, r: 0, aiFactionId: 2 }),
    testTile({ key: "-5,0", q: -5, r: 0, aiFactionId: 2 }),
    testTile({ key: "-5,1", q: -5, r: 1, aiFactionId: 2 })
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 51,
      currentMa: 201,
      reproduction: 0,
      population: 100,
      aiFactions
    },
    aiTiles
  );

  const next = advanceTurn(state);
  const aiOneTileCount = [...next.tiles.values()].filter((tile) => tile.aiFactionId === 1).length;
  const aiTwoTileCount = [...next.tiles.values()].filter((tile) => tile.aiFactionId === 2).length;

  assert.equal(next.aiFactions.find((faction) => faction.id === 1).population, 5);
  // 无领地的幽灵 AI 派系现在会被自动清理，不再保留有人口无领土的脏状态。
  assert.equal(next.aiFactions.find((faction) => faction.id === 2), undefined);
  assert.equal(aiOneTileCount, 3);
  assert.equal(aiTwoTileCount, 0);
  assertConnectedTiles([...next.tiles.values()].filter((tile) => tile.aiFactionId === 1));
});

test("mass extinction AI survivors stay connected", () => {
  const aiFactions = [{ id: 1, waveIndex: 1, spawnTurn: 52, originKey: "4,0", population: 60, basePower: 1 }];
  const aiTiles = [
    testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
    testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1 }),
    testTile({ key: "5,-1", q: 5, r: -1, aiFactionId: 1 }),
    testTile({ key: "4,1", q: 4, r: 1, aiFactionId: 1 }),
    testTile({ key: "6,-1", q: 6, r: -1, aiFactionId: 1 })
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 51,
      currentMa: 201,
      reproduction: 0,
      population: 100,
      aiFactions
    },
    aiTiles
  );

  const next = advanceTurn(state);
  const aiSurvivors = [...next.tiles.values()].filter((tile) => tile.aiFactionId === 1);

  assert.equal(aiSurvivors.length, 3);
  assertConnectedTiles(aiSurvivors);
});

test("mass extinction caps high-population AI factions to ten connected tiles", () => {
  const aiFactions = [{ id: 1, waveIndex: 1, spawnTurn: 52, originKey: "4,0", population: 500, basePower: 1 }];
  const aiTiles = Array.from({ length: 12 }, (_, index) => {
    const q = index + 4;
    return testTile({ key: `${q},0`, q, r: 0, aiFactionId: 1 });
  });
  const state = withTiles(
    {
      ...withoutAi(createInitialState({ seed: 7429 })),
      turn: 51,
      currentMa: 201,
      reproduction: 0,
      population: 100,
      aiFactions
    },
    aiTiles
  );

  const next = advanceTurn(state);
  const aiSurvivors = [...next.tiles.values()].filter((tile) => tile.aiFactionId === 1);

  assert.equal(next.aiFactions.find((faction) => faction.id === 1).population, 50);
  assert.equal(aiSurvivors.length, 10);
  assertConnectedTiles(aiSurvivors);
});

test("mass extinction also triggers after Jurassic", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "-1,0", q: -1, r: 0, owned: true }),
    testTile({ key: "0,1", q: 0, r: 1, owned: true }),
    testTile({ key: "0,-1", q: 0, r: -1, owned: true }),
    testTile({ key: "1,-1", q: 1, r: -1, owned: true })
  ];
  const state = withTiles(
    {
      ...createInitialState({ seed: 7429 }),
      turn: 107,
      currentMa: 145,
      reproduction: 0,
      population: 100
    },
    ownedTiles
  );

  const next = advanceTurn(state);

  assert.equal(next.currentMa, 144);
  assert.equal(next.population, 10);
  assert.equal(getOwnedTiles(next).length, 5);
  assert.equal(next.notices[0].type, "mass-extinction");
});

test("mass extinction rerolls generated terrain and keeps survivor terrain conquerable", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, terrain: "desert", combatBonus: 1, owned: true, generatedTurn: 3 }),
    testTile({ key: "2,0", q: 2, r: 0, terrain: "forest", owned: true, generatedTurn: 3 }),
    testTile({ key: "3,0", q: 3, r: 0, terrain: "grassland", populationMultiplierDelta: 1, owned: true, generatedTurn: 3 })
  ];
  const generatedTile = testTile({
    key: "4,0",
    q: 4,
    r: 0,
    terrain: "desert",
    combatBonus: 1,
    owned: false,
    generatedTurn: 3
  });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 51,
      currentMa: 201,
      reproduction: 0,
      population: 80
    },
    [...ownedTiles, generatedTile]
  );
  const beforeTerrain = state.tiles.get("4,0").terrain;

  const next = advanceTurn(state);
  const survivors = getOwnedTiles(next);

  assert.equal(next.terrainEpoch, 1);
  assert.equal(next.tiles.get("4,0").generatedTurn, 52);
  assert.equal(next.tiles.get("4,0").terrain === beforeTerrain && next.tiles.get("4,0").generatedTurn === 3, false);
  for (const tile of survivors) {
    assert.equal(tile.conquerable, true);
    assert.equal(["grassland", "forest", "desert"].includes(tile.terrain), true);
  }
});

test("terrain epoch changes future generated tile terrain", () => {
  const before = createTile({ q: 7, r: -2 }, 52, 12345, false, 0);
  const after = createTile({ q: 7, r: -2 }, 52, 12345, false, 1);

  assert.notDeepEqual(
    {
      terrain: after.terrain,
      combatRequired: after.combatRequired,
      populationCost: after.populationCost,
      populationMultiplierDelta: after.populationMultiplierDelta,
      combatBonus: after.combatBonus,
      conquerable: after.conquerable
    },
    {
      terrain: before.terrain,
      combatRequired: before.combatRequired,
      populationCost: before.populationCost,
      populationMultiplierDelta: before.populationMultiplierDelta,
      combatBonus: before.combatBonus,
      conquerable: before.conquerable
    }
  );
});

test("mass extinction never creates survivor territory beyond existing owned tiles", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "-1,0", q: -1, r: 0, owned: true })
  ];
  const state = withTiles(
    {
      ...createInitialState(),
      turn: 51,
      currentMa: 201,
      reproduction: 0,
      population: 500
    },
    ownedTiles
  );

  const next = advanceTurn(state);

  assert.equal(next.population, 50);
  assert.equal(getOwnedTiles(next).length, 3);
  assert.equal(next.notices[0].tilesBefore, 3);
  assert.equal(next.notices[0].tilesAfter, 3);
  assert.equal(next.notices[0].removedTileCount, 0);
});

test("mass extinction triggers failure when survivor count rounds to zero territory", () => {
  const ownedTiles = [
    testTile({ key: "1,0", q: 1, r: 0, owned: true }),
    testTile({ key: "-1,0", q: -1, r: 0, owned: true })
  ];
  const state = withTiles(
    {
      ...createInitialState(),
      turn: 51,
      currentMa: 201,
      activeCoord: { q: 1, r: 0 },
      reproduction: 0,
      population: 1
    },
    ownedTiles
  );

  const next = advanceTurn(state);

  assert.equal(next.population, 1);
  assert.equal(getOwnedTiles(next).length, 0);
  assert.equal(next.gameOver, true);
  assert.equal(next.pendingMutationChoice, false);
  assert.equal(next.result.type, "extinction");
  assert.deepEqual(next.activeCoord, { q: 0, r: 0 });
  assert.equal(next.visibleKeys.length, 0);
  assert.equal(next.notices[0].tilesBefore, 3);
  assert.equal(next.notices[0].tilesAfter, 0);
  assert.equal(next.notices[0].removedTileCount, 3);
});

test("origin reveals its six neighboring hexes", () => {
  const state = createInitialState();

  assert.equal(state.visibleKeys.length, 6);
});

test("visible frontier includes every unowned neighbor of owned territory", () => {
  let state = createInitialState();
  const chosen = [...state.tiles.values()].find((tile) => !tile.owned && tile.conquerable !== false);
  state = {
    ...state,
    basePower: 20,
    population: 100
  };

  const expanded = expandToTile(state, chosen.key);
  const ownedKeys = new Set([...expanded.tiles.values()].filter((tile) => tile.owned).map((tile) => tile.key));

  for (const ownedKey of ownedKeys) {
    const tile = expanded.tiles.get(ownedKey);
    const neighborKeys = [
      `${tile.q + 1},${tile.r}`,
      `${tile.q + 1},${tile.r - 1}`,
      `${tile.q},${tile.r - 1}`,
      `${tile.q - 1},${tile.r}`,
      `${tile.q - 1},${tile.r + 1}`,
      `${tile.q},${tile.r + 1}`
    ];

    for (const key of neighborKeys) {
      if (!ownedKeys.has(key)) {
        assert.equal(expanded.visibleKeys.includes(key), true);
      }
    }
  }

  assert.equal(expanded.visibleKeys.length, 8);
});

test("expansion checks both total power and effective population cost", () => {
  let state = createInitialState();
  const lockedTile = [...state.tiles.values()].find((tile) => !tile.owned && tile.conquerable !== false);

  assert.equal(canExpandTo(state, lockedTile), false);

  state = {
    ...state,
    basePower: 20,
    population: 100
  };
  const affordable = state.tiles.get(lockedTile.key);
  assert.equal(canExpandTo(state, affordable), true);
});

test("expansion requires population to exceed the target cost", () => {
  const tile = testTile({ key: "1,0", q: 1, r: 0, combatRequired: 1, populationCost: 10 });
  const exactPopulationState = withTiles(
    {
      ...withoutAi(createInitialState()),
      basePower: 20,
      population: 10
    },
    [tile]
  );
  const surplusPopulationState = {
    ...exactPopulationState,
    population: 11
  };

  assert.equal(canExpandTo(exactPopulationState, tile), false);
  assert.equal(canExpandTo(surplusPopulationState, tile), true);
  assert.equal(expandToTile(exactPopulationState, tile.key).tiles.get(tile.key).owned, false);
});

test("successful expansion spends population and applies terrain bonuses", () => {
  let state = createInitialState();
  const chosen = [...state.tiles.values()].find((tile) => !tile.owned && tile.conquerable !== false);
  state = {
    ...state,
    basePower: 20,
    population: 100
  };

  const expanded = expandToTile(state, chosen.key);

  assert.equal(expanded.population, 100 - getEffectivePopulationCost(state, chosen));
  assert.equal(expanded.tiles.get(chosen.key).owned, true);
  assert.equal(getTilePowerBonus(expanded) >= 0, true);
  assert.equal(getPopulationMultiplier(expanded) >= 1, true);
});

test("forest expansion grants temporary power instead of permanent tile power", () => {
  const initialState = createInitialState();
  const forest = testTile();
  const state = withTiles(
    {
      ...initialState,
      basePower: 20,
      population: 100
    },
    [forest]
  );

  const expanded = expandToTile(state, forest.key);

  assert.equal(getTilePowerBonus(expanded), 0);
  assert.equal(getTemporaryPowerBonus(expanded), 1);
  assert.equal(getTotalPower(expanded), 21);
});

test("forest temporary power stacks within the same 5Ma interval", () => {
  const initialState = {
    ...createInitialState({ seed: 7429 }),
    turn: 2,
    currentMa: 250,
    basePower: 20,
    population: 100
  };
  const firstForest = testTile();
  const secondForest = testTile({ key: "-1,0", q: -1, r: 0 });
  let state = withTiles(initialState, [firstForest]);

  state = expandToTile(state, firstForest.key);
  state = advanceTurn(state);
  state = withTiles(state, [secondForest]);
  state = expandToTile(state, secondForest.key);

  assert.equal(getTemporaryPowerBonus(state), 2);
  assert.equal(getTotalPower(state), 22);
});

test("forest temporary power clears at each 5Ma cycle start", () => {
  const state = {
    ...createInitialState(),
    turn: 5,
    currentMa: 247,
    basePower: 20,
    temporaryPowerBonus: 2
  };

  const next = advanceTurn(state);

  assert.equal(next.turn, 6);
  assert.equal(next.pendingMutationChoice, true);
  assert.equal(getTemporaryPowerBonus(next), 0);
  assert.equal(getTotalPower(next), 20);
});

test("only one tile can be expanded per turn without a special ability", () => {
  let state = createInitialState({ seed: 7429 });
  const firstTile = [...state.tiles.values()].find((tile) => !tile.owned && tile.conquerable !== false);
  state = {
    ...state,
    turn: 2,
    currentMa: 250,
    basePower: 20,
    population: 100
  };

  const expanded = expandToTile(state, firstTile.key);
  const secondTile = [...expanded.tiles.values()].find((tile) => tile.revealed && !tile.owned && tile.conquerable !== false);

  assert.equal(expanded.hasExpandedThisTurn, true);
  assert.equal(canExpandTo(expanded, secondTile), false);

  const blocked = expandToTile(expanded, secondTile.key);
  assert.equal(blocked.tiles.get(secondTile.key).owned, false);

  const nextTurn = advanceTurn(expanded);
  assert.equal(nextTurn.hasExpandedThisTurn, false);
  assert.equal(canExpandTo(nextTurn, nextTurn.tiles.get(secondTile.key)), true);
});

test("mountain and water tiles stay blocked without the mountain holding mutation", () => {
  for (const terrain of ["mountain", "water"]) {
    const state = withTiles(
      {
        ...createInitialState(),
        basePower: 20,
        population: 100
      },
      [
        {
          key: "1,0",
          q: 1,
          r: 0,
          terrain,
          combatRequired: 0,
          populationCost: 0,
          populationMultiplierDelta: 0,
          combatBonus: 0,
          conquerable: false,
          revealed: true,
          owned: false
        }
      ]
    );

    const tile = state.tiles.get("1,0");
    assert.equal(canExpandTo(state, tile), false);

    const expanded = expandToTile(state, tile.key);
    assert.equal(expanded.tiles.get(tile.key).owned, false);
    assert.equal(expanded.population, state.population);
  }
});

test("mountain holding allows mountain conquest but does not unlock water", () => {
  const state = withTiles(
    withMutations(
      {
        ...createInitialState(),
        basePower: 20,
        population: 100
      },
      ["mountain_hold"]
    ),
    [
      {
        key: "1,0",
        q: 1,
        r: 0,
        terrain: "mountain",
        combatRequired: 0,
        populationCost: 0,
        populationMultiplierDelta: 0,
        combatBonus: 0,
        conquerable: false,
        revealed: true,
        owned: false
      },
      {
        key: "0,1",
        q: 0,
        r: 1,
        terrain: "water",
        combatRequired: 0,
        populationCost: 0,
        populationMultiplierDelta: 0,
        combatBonus: 0,
        conquerable: false,
        revealed: true,
        owned: false
      }
    ]
  );

  assert.equal(canExpandTo(state, state.tiles.get("1,0")), true);
  assert.equal(canExpandTo(state, state.tiles.get("0,1")), false);
});

test("generated tile combat requirements increase over time", () => {
  const early = generateTileCombatRequirement(1, "forest", mulberry32(100));
  const late = generateTileCombatRequirement(180, "forest", mulberry32(100));

  assert.equal(late > early, true);
});

test("generated tile population costs increase more sharply over time", () => {
  const early = generateTilePopulationCost(1, "forest", mulberry32(100));
  const late = generateTilePopulationCost(180, "forest", mulberry32(100));

  assert.equal(late - early >= 18, true);
});

test("generated tiles keep fixed values after being stored", () => {
  const tile = createTile({ q: 2, r: -1 }, 10, 42, false);
  const state = ensureVisibleTiles({
    ...createInitialState(),
    turn: 100,
    activeCoord: { q: 0, r: 0 },
    tiles: new Map([[tile.key, tile]])
  });

  assert.equal(state.tiles.get(tile.key).combatRequired, tile.combatRequired);
});

test("stored tile requirements rise dynamically after their generated turn", () => {
  const tile = testTile({ combatRequired: 4, populationCost: 5, generatedTurn: 0 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 45
    },
    [tile]
  );

  assert.equal(getEffectiveCombatRequirement(state, tile), 7);
  assert.equal(getEffectivePopulationCost(state, tile), 9);
  assert.equal(state.tiles.get(tile.key).combatRequired, 4);
  assert.equal(state.tiles.get(tile.key).populationCost, 5);
});

test("stored tiles without generated turns use the current turn as their baseline", () => {
  const tile = testTile({ combatRequired: 4, populationCost: 5 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 45
    },
    [tile]
  );

  assert.equal(getEffectiveCombatRequirement(state, tile), 4);
  assert.equal(getEffectivePopulationCost(state, tile), 5);
});

test("expansion spends dynamically increased population cost", () => {
  const tile = testTile({ combatRequired: 1, populationCost: 5, generatedTurn: 0 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 25,
      currentMa: 227,
      basePower: 20,
      population: 100
    },
    [tile]
  );

  const expanded = expandToTile(state, tile.key);

  assert.equal(getExpansionPopulationCost(state, tile), 7);
  assert.equal(expanded.population, 93);
  assert.equal(expanded.tiles.get(tile.key).owned, true);
});

test("initial AI factions spawn on ring 5 with warning directions but stay hidden", () => {
  const state = createInitialState();

  assert.equal(state.aiFactions.length, 2);
  for (const faction of state.aiFactions) {
    const tile = state.tiles.get(faction.originKey);
    assert.equal(faction.initial, true);
    assert.equal(faction.waveIndex, 0);
    assert.equal(faction.spawnTurn, 0);
    assert.equal(faction.population, 16);
    assert.equal(faction.basePower, 1);
    assert.equal(faction.growthRate, 1);
    assert.equal(faction.growthPower, 0);
    assert.equal(faction.cycleForestPower, 0);
    assert.equal(typeof faction.warningDirection, "string");
    assert.equal(axialDistance(tile), 5);
    assert.equal(tile.owned, false);
    assert.equal(tile.conquerable, true);
    assert.equal(tile.revealed, false);
  }
});

test("scheduled AI factions still spawn every 20 turns after initial factions", () => {
  let state = advanceMany(createInitialState({ seed: 7429 }), 20);
  assert.equal(state.turn, 20);
  assert.equal(state.aiFactions.length, 3);

  const scheduledFaction = state.aiFactions.find((faction) => !faction.initial);
  const scheduledAiTiles = [...state.tiles.values()].filter((tile) => tile.aiFactionId === scheduledFaction.id);
  assert.equal(scheduledFaction.waveIndex, 1);
  assert.equal(scheduledFaction.spawnTurn, 20);
  assert.equal(scheduledFaction.population, 44);
  assert.equal(scheduledFaction.basePower, 2);
  assert.equal(scheduledFaction.growthRate, 2);
  assert.equal(scheduledFaction.growthPower, 0);
  assert.equal(scheduledFaction.cycleForestPower, 0);
  assert.equal(typeof scheduledFaction.warningDirection, "string");
  assert.equal(minDistanceToPlayerBoundary(state, state.tiles.get(scheduledFaction.originKey)) >= 3, true);
  assert.equal(minDistanceToPlayerBoundary(state, state.tiles.get(scheduledFaction.originKey)) <= 6, true);
  assert.equal(scheduledAiTiles.length, 4);
  assert.equal(scheduledAiTiles[0].owned, false);
  assert.equal(scheduledAiTiles[0].conquerable, true);
  assert.equal(scheduledAiTiles[0].revealed, false);

  state = advanceMany(state, 20);
  assert.equal(state.turn, 40);
  assert.equal(state.aiFactions.length >= 3, true);
  const secondScheduledFaction = state.aiFactions.find((faction) => faction.waveIndex === 2);
  assert.notEqual(secondScheduledFaction, undefined);
});

test("second scheduled AI wave uses scaled spawn stats", () => {
  const state = advanceTurn({
    ...withoutAi(createInitialState({ seed: 7429 })),
    turn: 39,
    currentMa: 213,
    scheduledAiWaveCount: 1
  });
  const secondScheduledFaction = state.aiFactions.find((faction) => faction.waveIndex === 2);

  assert.notEqual(secondScheduledFaction, undefined);
  const secondScheduledAiTiles = [...state.tiles.values()].filter((tile) => tile.aiFactionId === secondScheduledFaction.id);
  assert.equal(secondScheduledFaction.waveIndex, 2);
  assert.equal(secondScheduledFaction.population, 72);
  assert.equal(secondScheduledFaction.spawnTurn, 40);
  assert.equal(secondScheduledFaction.basePower, 4);
  assert.equal(secondScheduledFaction.growthRate, 4);
  assert.equal(secondScheduledFaction.growthPower, 0);
  assert.equal(minDistanceToPlayerBoundary(state, state.tiles.get(secondScheduledFaction.originKey)) >= 3, true);
  assert.equal(minDistanceToPlayerBoundary(state, state.tiles.get(secondScheduledFaction.originKey)) <= 6, true);
  assert.equal(secondScheduledAiTiles.length, 8);
});

test("scheduled AI spawn follows the current player boundary", () => {
  const state = advanceTurn(
    withTiles(
      {
        ...withoutAi(createInitialState({ seed: 7429 })),
        turn: 19,
        currentMa: 233,
        reproduction: 0
      },
      [
        testTile({ key: "0,0", q: 0, r: 0, terrain: "origin", owned: false, revealed: false }),
        testTile({ key: "30,0", q: 30, r: 0, owned: true, revealed: true })
      ]
    )
  );
  const faction = state.aiFactions.find((candidate) => candidate.waveIndex === 1);
  const originTile = state.tiles.get(faction.originKey);

  assert.notEqual(faction, undefined);
  assert.equal(minDistanceToPlayerBoundary(state, originTile) >= 3, true);
  assert.equal(minDistanceToPlayerBoundary(state, originTile) <= 6, true);
  assert.equal(axialDistance(originTile) > 6, true);
});

test("Jurassic scheduled AI applies era power and population multipliers only", () => {
  const state = advanceTurn({
    ...withoutAi(createInitialState({ seed: 7429 })),
    turn: 59,
    currentMa: 193,
    scheduledAiWaveCount: 2
  });
  const faction = state.aiFactions.find((candidate) => candidate.waveIndex === 3);

  assert.notEqual(faction, undefined);
  assert.equal(state.turn, 60);
  assert.equal(state.currentMa, 192);
  assert.equal(faction.population, 200);
  assert.equal(faction.basePower, 9);
  assert.equal(faction.growthRate, 6);
  assert.equal(faction.growthPower, 0);
});

test("Cretaceous scheduled AI applies era power and population multipliers only", () => {
  const state = advanceTurn({
    ...withoutAi(createInitialState({ seed: 7429 })),
    turn: 119,
    currentMa: 133,
    scheduledAiWaveCount: 5
  });
  const faction = state.aiFactions.find((candidate) => candidate.waveIndex === 6);

  assert.notEqual(faction, undefined);
  assert.equal(state.turn, 120);
  assert.equal(state.currentMa, 132);
  assert.equal(faction.population, 552);
  assert.equal(faction.basePower, 24);
  assert.equal(faction.growthRate, 12);
  assert.equal(faction.growthPower, 0);

  const spawnedTiles = [...state.tiles.values()].filter((tile) => tile.aiFactionId === faction.id);
  assert.equal(spawnedTiles.length, 24);
  assertConnectedTiles(spawnedTiles);
});

test("scheduled AI base power stays below expected player basic-power curve", () => {
  let state = createInitialState({ seed: 7429 });
  const expectedPlayerBasePowerByTurn = new Map([
    [20, 5],
    [40, 9],
    [60, 13],
    [120, 25]
  ]);
  const expectedAiBasePowerByTurn = new Map([
    [20, 2],
    [40, 4],
    [60, 9],
    [120, 24]
  ]);

  for (let turn = 0; turn < 120; turn += 1) {
    if (state.pendingMutationChoice) {
      state = chooseMutation(state, "basic_power");
    }
    state = advanceTurn(state);

    const expectedPlayerBasePower = expectedPlayerBasePowerByTurn.get(state.turn);
    if (!expectedPlayerBasePower) continue;

    const waveIndex = state.turn / 20;
    const faction = state.aiFactions.find((candidate) => !candidate.initial && candidate.waveIndex === waveIndex);
    assert.notEqual(faction, undefined);
    assert.equal(state.basePower, expectedPlayerBasePower);
    assert.equal(faction.basePower, expectedAiBasePowerByTurn.get(state.turn));
    assert.equal(faction.basePower < state.basePower, true);
  }
});

test("scheduled AI boundary spawn keeps occupied tiles intact", () => {
  const blockedSpawnRing = ringTiles(14, 16, blockedTile);
  const origin = testTile({ key: "14,0", q: 14, r: 0, revealed: false });
  const openNeighbor = testTile({ key: "15,0", q: 15, r: 0, revealed: false });
  const playerNeighbor = testTile({ key: "14,-1", q: 14, r: -1, owned: true, revealed: true });
  const aiNeighbor = testTile({ key: "15,-1", q: 15, r: -1, aiFactionId: 99, revealed: false });
  const blockedOriginNeighbors = [blockedTile("13,0", 13, 0), blockedTile("13,1", 13, 1), blockedTile("14,1", 14, 1)];
  const ownedPath = Array.from({ length: 13 }, (_, index) => {
    const q = index + 1;
    return testTile({ key: `${q},0`, q, r: 0, owned: true, revealed: true });
  });
  const state = advanceTurn(
    withTiles(
      {
        ...withoutAi(createInitialState({ seed: 7429 })),
        population: 100,
        basePower: 100,
        turn: 119,
        currentMa: 133,
        scheduledAiWaveCount: 5,
        aiFactions: [{ id: 99, waveIndex: 1, spawnTurn: 20, originKey: "15,-1", population: 20, basePower: 1 }]
      },
      [...blockedSpawnRing, ...blockedOriginNeighbors, ...ownedPath, origin, openNeighbor, playerNeighbor, aiNeighbor]
    )
  );
  const faction = state.aiFactions.find((candidate) => candidate.waveIndex === 6 && candidate.id !== 99);
  const spawnedTiles = [...state.tiles.values()].filter((tile) => tile.aiFactionId === faction.id);

  assert.notEqual(faction, undefined);
  assert.equal(spawnedTiles.length, 24);
  assert.equal(minDistanceToPlayerBoundary(state, state.tiles.get(faction.originKey)) >= 3, true);
  assert.equal(minDistanceToPlayerBoundary(state, state.tiles.get(faction.originKey)) <= 8, true);
  assert.equal(spawnedTiles.every((tile) => tile.owned === false), true);
  assert.equal(spawnedTiles.every((tile) => tile.conquerable === true), true);
  assert.equal(state.tiles.get("14,-1").owned, true);
  assert.equal(state.tiles.get("14,-1").aiFactionId, undefined);
  assert.equal(state.tiles.get("15,-1").aiFactionId, 99);
  assertConnectedTiles(spawnedTiles);
});

test("AI power uses base, desert tiles, growth power, and cycle forest power", () => {
  const faction = {
    id: 1,
    waveIndex: 2,
    spawnTurn: 20,
    originKey: "4,0",
    population: 40,
    basePower: 2,
    growthPower: 4,
    cycleForestPower: 2
  };
  const aiTiles = [
    testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "desert" }),
    testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1, terrain: "desert" }),
    testTile({ key: "5,-1", q: 5, r: -1, aiFactionId: 1, terrain: "desert" }),
    testTile({ key: "4,1", q: 4, r: 1, aiFactionId: 1, terrain: "forest" })
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 60,
      aiFactions: [faction]
    },
    aiTiles
  );

  assert.equal(getAiFactionPower(state, faction), 11);
});

test("AI era power multiplier affects all factions without changing stored power", () => {
  const faction = {
    id: 1,
    waveIndex: 1,
    spawnTurn: 20,
    originKey: "4,0",
    population: 40,
    basePower: 2,
    growthPower: 1,
    cycleForestPower: 1
  };
  const aiTiles = [
    testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "desert" })
  ];
  const jurassic = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 60,
      currentMa: 192,
      aiFactions: [faction]
    },
    aiTiles
  );
  const cretaceous = { ...jurassic, currentMa: 132 };

  assert.equal(getAiFactionPower(jurassic, faction), 6);
  assert.equal(getAiFactionPower(cretaceous, faction), 6);
  assert.equal(faction.basePower, 2);
  assert.equal(faction.growthPower, 1);
});

test("initial AI power does not include scheduled wave scaling", () => {
  const faction = { id: 1, waveIndex: 0, spawnTurn: 0, originKey: "5,0", initial: true, population: 40, basePower: 1 };
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 40,
      aiFactions: [faction]
    },
    [
      testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1 }),
      testTile({ key: "5,-1", q: 5, r: -1, aiFactionId: 1 }),
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
      testTile({ key: "4,1", q: 4, r: 1, aiFactionId: 1 })
    ]
  );

  assert.equal(getAiFactionPower(state, faction), 1);
});

test("initial AI power still gains later era power multipliers", () => {
  const faction = { id: 1, waveIndex: 0, spawnTurn: 0, originKey: "5,0", initial: true, population: 40, basePower: 1 };
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 120,
      currentMa: 132,
      aiFactions: [faction]
    },
    [testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1 })]
  );

  assert.equal(getAiFactionPower(state, faction), 2);
  assert.equal(faction.basePower, 1);
});

test("AI population growth scales with controlled tile count", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 12, basePower: 1, growthRate: 3 };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "grassland" });
  const aiSecond = testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1, terrain: "grassland" });
  const blockers = [
    testTile({ key: "5,-1", q: 5, r: -1, conquerable: false }),
    testTile({ key: "4,-1", q: 4, r: -1, conquerable: false }),
    testTile({ key: "3,0", q: 3, r: 0, conquerable: false }),
    testTile({ key: "3,1", q: 3, r: 1, conquerable: false }),
    testTile({ key: "4,1", q: 4, r: 1, conquerable: false }),
    testTile({ key: "6,0", q: 6, r: 0, conquerable: false }),
    testTile({ key: "6,-1", q: 6, r: -1, conquerable: false }),
    testTile({ key: "5,1", q: 5, r: 1, conquerable: false })
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [faction]
    },
    [aiOrigin, aiSecond, ...blockers]
  );

  const next = advanceTurn(state);
  assert.equal(next.aiFactions[0].population, 20);
  assert.equal(next.log.some((entry) => entry.includes("敌群人口增长")), true);
});

test("AI era growth multiplier affects population growth without changing stored growth rate", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 12, basePower: 1, growthRate: 3 };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "grassland" });
  const aiSecond = testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1, terrain: "grassland" });
  const blockers = [
    testTile({ key: "5,-1", q: 5, r: -1, conquerable: false }),
    testTile({ key: "4,-1", q: 4, r: -1, conquerable: false }),
    testTile({ key: "3,0", q: 3, r: 0, conquerable: false }),
    testTile({ key: "3,1", q: 3, r: 1, conquerable: false }),
    testTile({ key: "4,1", q: 4, r: 1, conquerable: false }),
    testTile({ key: "6,0", q: 6, r: 0, conquerable: false }),
    testTile({ key: "6,-1", q: 6, r: -1, conquerable: false }),
    testTile({ key: "5,1", q: 5, r: 1, conquerable: false })
  ];
  const jurassic = advanceTurn(
    withTiles(
      {
        ...withoutAi(createInitialState()),
        turn: 61,
        currentMa: 191,
        aiFactions: [faction]
      },
      [aiOrigin, aiSecond, ...blockers]
    )
  );
  const cretaceous = advanceTurn(
    withTiles(
      {
        ...withoutAi(createInitialState()),
        turn: 121,
        currentMa: 131,
        aiFactions: [faction]
      },
      [aiOrigin, aiSecond, ...blockers]
    )
  );

  assert.equal(jurassic.aiFactions[0].population, 24);
  assert.equal(jurassic.aiFactions[0].growthRate, 3);
  assert.equal(cretaceous.aiFactions[0].population, 24);
  assert.equal(cretaceous.aiFactions[0].growthRate, 3);
});

test("AI population uses base growth without grassland tiles", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 1, basePower: 1, growthRate: 3 };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "forest" });
  const aiSecond = testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 1, terrain: "desert" });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [faction]
    },
    [aiOrigin, aiSecond]
  );

  const next = advanceTurn(state);
  assert.equal(next.aiFactions[0].population, 3);
  assert.equal(next.aiFactions[0].growthRate, 3);
  assert.equal([...next.tiles.values()].filter((tile) => tile.aiFactionId === 1).length, 2);
});

test("AI 5Ma growth upgrades either reproduction or growth power and resets forest power", () => {
  const faction = {
    id: 1,
    waveIndex: 1,
    spawnTurn: 20,
    originKey: "4,0",
    population: 1,
    basePower: 1,
    growthRate: 2,
    growthPower: 3,
    cycleForestPower: 2
  };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "grassland" });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 24,
      currentMa: 228,
      seed: 1,
      aiFactions: [faction]
    },
    [aiOrigin]
  );

  const next = advanceTurn(state);
  const upgraded = next.aiFactions[0];
  assert.equal(next.turn, 25);
  assert.equal(upgraded.cycleForestPower, 0);
  assert.equal(upgraded.growthRate + upgraded.growthPower, faction.growthRate + faction.growthPower + 1);
  assert.equal(
    upgraded.growthRate === faction.growthRate + 1 || upgraded.growthPower === faction.growthPower + 1,
    true
  );
  assert.equal(next.log.some((entry) => entry.includes("敌群周期成长")), true);
});

test("AI factions expand once per turn when not touching player territory", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0" };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [faction]
    },
    [aiOrigin]
  );

  const next = advanceTurn(state);
  const aiTileCount = [...next.tiles.values()].filter((tile) => tile.aiFactionId === 1).length;
  assert.equal(aiTileCount, 2);
  assert.equal(next.log.some((entry) => entry.includes("敌群 #1 扩张")), true);
  assert.equal(
    getRecentTurnHistory(next, 1)[0].events.some((event) => event.text.includes("敌群 #1 扩张") && event.showInGameOver === false),
    true
  );
});

test("AI expansion requires population to exceed the target cost", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 1, basePower: 1 };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 });
  const neighbors = [
    testTile({ key: "5,0", q: 5, r: 0, populationCost: 3 }),
    testTile({ key: "5,-1", q: 5, r: -1, populationCost: 9 }),
    testTile({ key: "4,-1", q: 4, r: -1, populationCost: 9 }),
    testTile({ key: "3,0", q: 3, r: 0, populationCost: 9 }),
    testTile({ key: "3,1", q: 3, r: 1, populationCost: 9 }),
    testTile({ key: "4,1", q: 4, r: 1, populationCost: 9 })
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [faction]
    },
    [aiOrigin, ...neighbors]
  );

  const next = advanceTurn(state);
  assert.equal([...next.tiles.values()].filter((tile) => tile.aiFactionId === 1).length, 1);
});

test("AI expansion uses dynamically increased population cost", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 3, basePower: 1 };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 });
  const neighbors = [
    testTile({ key: "5,0", q: 5, r: 0, populationCost: 3, generatedTurn: 0 }),
    testTile({ key: "5,-1", q: 5, r: -1, populationCost: 9, generatedTurn: 0 }),
    testTile({ key: "4,-1", q: 4, r: -1, populationCost: 9, generatedTurn: 0 }),
    testTile({ key: "3,0", q: 3, r: 0, populationCost: 9, generatedTurn: 0 }),
    testTile({ key: "3,1", q: 3, r: 1, populationCost: 9, generatedTurn: 0 }),
    testTile({ key: "4,1", q: 4, r: 1, populationCost: 9, generatedTurn: 0 })
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [faction]
    },
    [aiOrigin, ...neighbors]
  );

  const next = advanceTurn(state);
  assert.equal([...next.tiles.values()].filter((tile) => tile.aiFactionId === 1).length, 1);
});

test("AI expansion spends population cost and forest captures add cycle power", () => {
  const faction = {
    id: 1,
    waveIndex: 1,
    spawnTurn: 20,
    originKey: "4,0",
    population: 5,
    basePower: 1,
    growthRate: 3,
    growthPower: 0,
    cycleForestPower: 0
  };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "desert" });
  const neighbors = [
    testTile({ key: "5,0", q: 5, r: 0, terrain: "forest", populationCost: 3 }),
    testTile({ key: "5,-1", q: 5, r: -1, terrain: "grassland", populationCost: 9 }),
    testTile({ key: "4,-1", q: 4, r: -1, terrain: "grassland", populationCost: 9 }),
    testTile({ key: "3,0", q: 3, r: 0, terrain: "grassland", populationCost: 9 }),
    testTile({ key: "3,1", q: 3, r: 1, terrain: "grassland", populationCost: 9 }),
    testTile({ key: "4,1", q: 4, r: 1, terrain: "grassland", populationCost: 9 })
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [faction]
    },
    [aiOrigin, ...neighbors]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("5,0").aiFactionId, 1);
  assert.equal(next.aiFactions[0].population, 4);
  assert.equal(next.aiFactions[0].cycleForestPower, 1);
});

test("AI skips ordinary expansion when pre-growth average population per tile is below two", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 4, basePower: 1, growthRate: 0 };
  const aiOrigin = testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "forest" });
  const aiSecond = testTile({ key: "4,-1", q: 4, r: -1, aiFactionId: 1, terrain: "forest" });
  const aiThird = testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, terrain: "forest" });
  const expansionTarget = testTile({ key: "5,0", q: 5, r: 0, populationCost: 1 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [faction]
    },
    [aiOrigin, aiSecond, aiThird, expansionTarget]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("5,0").aiFactionId, undefined);
  assert.equal(next.aiFactions[0].population, 6);
});

test("AI expands instead of attacking player territory when it has lower power", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "1,0", population: 8, basePower: 1 };
  const aiOrigin = testTile({ key: "1,0", q: 1, r: 0, aiFactionId: 1, terrain: "forest" });
  const expansionTarget = testTile({ key: "2,0", q: 2, r: 0, populationCost: 3 });
  const blockers = [
    blockedTile("2,-1", 2, -1),
    blockedTile("1,-1", 1, -1),
    blockedTile("0,1", 0, 1),
    blockedTile("1,1", 1, 1)
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      basePower: 5,
      aiFactions: [faction]
    },
    [aiOrigin, expansionTarget, ...blockers]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(next.tiles.get("0,0").aiFactionId, undefined);
  assert.equal(next.tiles.get("2,0").aiFactionId, 1);
  assert.equal(next.aiFactions[0].population, 7);
});

test("AI skips expansion when it overpowers player territory but cannot afford capture loss", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "1,0", population: 12, basePower: 2, growthRate: 0 };
  const aiTile = testTile({ key: "1,0", q: 1, r: 0, aiFactionId: 1 });
  const expansionTarget = testTile({ key: "2,0", q: 2, r: 0, populationCost: 3 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      population: 100,
      basePower: 1,
      aiFactions: [faction]
    },
    [
      aiTile,
      expansionTarget,
      blockedTile("2,-1", 2, -1),
      blockedTile("1,-1", 1, -1),
      blockedTile("0,1", 0, 1),
      blockedTile("1,1", 1, 1)
    ]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(next.tiles.get("0,0").aiFactionId, undefined);
  assert.equal(next.tiles.get("2,0").aiFactionId, undefined);
  assert.equal(next.population, 101);
  assert.equal(next.aiFactions[0].population, 14);
  assert.equal([...next.tiles.values()].filter((tile) => tile.aiFactionId === 1).length, 1);
  assert.equal(next.log.some((entry) => entry.includes("敌对族群攻占")), false);
});

test("AI attacks adjacent player territory when capture loss leaves population alive", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "1,0", population: 305, basePower: 2, growthRate: 0 };
  const aiTile = testTile({ key: "1,0", q: 1, r: 0, aiFactionId: 1 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      population: 100,
      basePower: 1,
      aiFactions: [faction]
    },
    [aiTile]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("0,0").owned, false);
  assert.equal(next.tiles.get("0,0").aiFactionId, 1);
  assert.equal(next.population, 0);
  assert.equal(next.aiFactions[0].population, 4);
  assert.equal(next.log.some((entry) => entry.includes("敌群损失 303，种群损失 152")), true);
});

test("AI capture of player territory resets stale revealed tiles", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "1,0", population: 305, basePower: 2, growthRate: 0 };
  const aiTile = testTile({ key: "1,0", q: 1, r: 0, aiFactionId: 1, revealed: true });
  const backupTerritory = testTile({ key: "-1,0", q: -1, r: 0, owned: true });
  const state = withStaleVision(withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      population: 100,
      reproduction: 0,
      basePower: 1,
      aiFactions: [faction]
    },
    [aiTile, backupTerritory]
  ));

  const next = advanceTurn(state);

  assert.equal(next.tiles.get("0,0").owned, false);
  assert.equal(next.tiles.get("0,0").aiFactionId, 1);
  assert.equal(next.tiles.get("-1,0").owned, true);
  assert.equal(next.tiles.get("1,0").revealed, false);
  assertVisionResetToCurrentFrontier(next);
});

test("AI attacking a player forest tile adds cycle forest power", () => {
  const faction = {
    id: 1,
    waveIndex: 1,
    spawnTurn: 20,
    originKey: "1,0",
    population: 305,
    basePower: 2,
    growthRate: 0,
    cycleForestPower: 0
  };
  const playerForest = testTile({ key: "0,0", q: 0, r: 0, terrain: "forest", owned: true });
  const aiTile = testTile({ key: "1,0", q: 1, r: 0, aiFactionId: 1 });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      population: 100,
      basePower: 1,
      aiFactions: [faction]
    },
    [playerForest, aiTile]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("0,0").aiFactionId, 1);
  assert.equal(next.aiFactions[0].cycleForestPower, 1);
});

test("AI expands instead of attacking player territory when player power meets AI power", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "1,0", population: 12, basePower: 2, growthRate: 0 };
  const aiTile = testTile({ key: "1,0", q: 1, r: 0, aiFactionId: 1, terrain: "forest" });
  const expansionTarget = testTile({ key: "2,0", q: 2, r: 0, populationCost: 4 });
  const blockers = [
    blockedTile("2,-1", 2, -1),
    blockedTile("1,-1", 1, -1),
    blockedTile("0,1", 0, 1),
    blockedTile("1,1", 1, 1)
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      population: 100,
      basePower: 2,
      aiFactions: [faction]
    },
    [aiTile, expansionTarget, ...blockers]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("0,0").owned, true);
  assert.equal(next.tiles.get("0,0").aiFactionId, undefined);
  assert.equal(next.tiles.get("2,0").aiFactionId, 1);
  assert.equal(next.population, 101);
});

test("AI captures lower-power AI territory and applies civil-war population losses", () => {
  const attacker = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 21, basePower: 5 };
  const defender = { id: 2, waveIndex: 1, spawnTurn: 22, originKey: "5,0", population: 9, basePower: 1 };
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [attacker, defender]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "4,-1", q: 4, r: -1, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "4,1", q: 4, r: 1, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 2, terrain: "forest" }),
      testTile({ key: "6,0", q: 6, r: 0, aiFactionId: 2, terrain: "forest" })
    ]
  );

  const next = advanceTurn(state);
  const nextAttacker = next.aiFactions.find((faction) => faction.id === 1);
  const nextDefender = next.aiFactions.find((faction) => faction.id === 2);
  assert.equal(next.tiles.get("5,0").aiFactionId, 1);
  assert.equal(nextAttacker.population, 5);
  assert.equal(nextDefender.population, 2);
  assert.equal(next.tiles.get("6,0").aiFactionId, 2);
  assert.equal(nextAttacker.cycleForestPower, 1);
  assert.equal(next.log.some((entry) => entry.includes("敌群 #1 攻占敌群 #2")), true);
});

test("AI skips expansion when it overpowers another AI but cannot afford capture loss", () => {
  const attacker = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 6, basePower: 5 };
  const defender = { id: 2, waveIndex: 1, spawnTurn: 22, originKey: "5,0", population: 9, basePower: 1 };
  const expansionTarget = testTile({ key: "4,1", q: 4, r: 1, populationCost: 3 });
  const blockers = [
    blockedTile("4,-1", 4, -1),
    blockedTile("3,0", 3, 0),
    blockedTile("3,1", 3, 1),
    blockedTile("5,-1", 5, -1),
    blockedTile("6,-1", 6, -1),
    blockedTile("6,0", 6, 0),
    blockedTile("5,1", 5, 1)
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [attacker, defender]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "4,-1", q: 4, r: -1, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 2, terrain: "forest" }),
      expansionTarget,
      ...blockers
    ]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("5,0").aiFactionId, 2);
  assert.equal(next.tiles.get("4,1").aiFactionId, undefined);
  assert.equal(next.aiFactions.find((faction) => faction.id === 1).population, 8);
  assert.equal(next.log.some((entry) => entry.includes("敌群 #1 攻占敌群 #2")), false);
});

test("AI expands instead of attacking equal-power AI territory", () => {
  const attacker = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 8, basePower: 2 };
  const defender = { id: 2, waveIndex: 1, spawnTurn: 22, originKey: "5,0", population: 8, basePower: 2 };
  const expansionTarget = testTile({ key: "4,1", q: 4, r: 1, populationCost: 3 });
  const blockers = [
    blockedTile("5,-1", 5, -1),
    blockedTile("4,-1", 4, -1),
    blockedTile("3,0", 3, 0),
    blockedTile("3,1", 3, 1)
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [attacker, defender]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "4,-1", q: 4, r: -1, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 2, terrain: "forest" }),
      expansionTarget,
      ...blockers
    ]
  );

  const next = advanceTurn(state);
  assert.equal(next.tiles.get("5,0").aiFactionId, 2);
  assert.equal(next.tiles.get("4,1").aiFactionId, 1);
});

test("later AI turns use population updated by earlier civil-war attacks", () => {
  const attacker = { id: 1, waveIndex: 1, spawnTurn: 20, originKey: "4,0", population: 20, basePower: 5 };
  const defender = { id: 2, waveIndex: 1, spawnTurn: 20, originKey: "5,0", population: 6, basePower: 1, growthRate: 0 };
  const defenderExpansionTarget = testTile({ key: "7,0", q: 7, r: 0, populationCost: 4 });
  const defenderBlockers = [
    blockedTile("7,-1", 7, -1),
    blockedTile("6,-1", 6, -1),
    blockedTile("5,1", 5, 1),
    blockedTile("6,1", 6, 1)
  ];
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 21,
      currentMa: 231,
      aiFactions: [attacker, defender]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "4,-1", q: 4, r: -1, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "4,1", q: 4, r: 1, aiFactionId: 1, terrain: "forest" }),
      testTile({ key: "5,0", q: 5, r: 0, aiFactionId: 2, terrain: "forest" }),
      testTile({ key: "6,0", q: 6, r: 0, aiFactionId: 2, terrain: "forest" }),
      defenderExpansionTarget,
      ...defenderBlockers
    ]
  );

  const next = advanceTurn(state);
  const nextDefender = next.aiFactions.find((faction) => faction.id === 2);
  assert.equal(next.tiles.get("5,0").aiFactionId, 1);
  assert.equal(nextDefender.population, 2);
  assert.equal(next.tiles.get("6,0").aiFactionId, 2);
  assert.equal(next.tiles.get("7,0").aiFactionId, undefined);
});

test("player recaptures visible AI tiles with density cost and terrain gains", () => {
  const aiTile = testTile({
    key: "1,0",
    q: 1,
    r: 0,
    aiFactionId: 1,
    terrain: "forest",
    combatRequired: 1,
    populationCost: 0,
    populationMultiplierDelta: 2,
    combatBonus: 3
  });
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      basePower: 20,
      population: 100,
      aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "1,0", population: 12, basePower: 1 }]
    },
    [aiTile]
  );

  assert.equal(canExpandTo(state, aiTile), true);
  assert.equal(getExpansionPopulationCost(state, aiTile), 36);
  const next = expandToTile(state, aiTile.key);

  assert.equal(next.tiles.get(aiTile.key).owned, true);
  assert.equal(next.tiles.get(aiTile.key).aiFactionId, null);
  assert.equal(next.tiles.get(aiTile.key).populationMultiplierDelta, 2);
  assert.equal(next.tiles.get(aiTile.key).combatBonus, 3);
  assert.equal(next.population, 64);
  assert.equal(next.aiFactions.some((faction) => faction.id === 1), false);
  assert.equal(next.log[0].includes("消耗 36 人口，敌群损失 18"), true);
  assert.equal(next.log.some((entry) => entry.includes("敌群 #1 人口归零，族群消亡")), true);
  assert.equal(getTilePowerBonus(next), 3);
  assert.equal(getPopulationMultiplier(next), 3);
  assert.equal(getTemporaryPowerBonus(next), 1);
});

test("AI habitat cutoff removes factions reduced to zero population", () => {
  const faction = { id: 1, waveIndex: 1, spawnTurn: 99, originKey: "4,0", population: 1, basePower: 0 };
  const state = withTiles(
    {
      ...withoutAi(createInitialState()),
      turn: 9,
      currentMa: 243,
      reproduction: 0,
      aiFactions: [faction]
    },
    [
      testTile({ key: "4,0", q: 4, r: 0, aiFactionId: 1 }),
      testTile({ key: "8,0", q: 8, r: 0, aiFactionId: 1 })
    ]
  );

  const next = advanceTurn(state);
  assert.equal(next.aiFactions.some((candidate) => candidate.id === 1), false);
  assert.equal(next.tiles.get("4,0").aiFactionId, null);
  assert.equal(next.tiles.get("8,0").aiFactionId, null);
  assert.equal(next.log.some((entry) => entry.includes("敌群 #1 人口归零，族群消亡")), true);
});

test("player recapturing AI tiles must exceed AI power", () => {
  const aiTile = testTile({ key: "1,0", q: 1, r: 0, aiFactionId: 1, combatRequired: 1, populationCost: 0 });
  const lowPowerState = withTiles(
    {
      ...withoutAi(createInitialState()),
      basePower: 4,
      population: 100,
      aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "1,0", population: 12, basePower: 4 }]
    },
    [aiTile]
  );
  const highPowerState = {
    ...lowPowerState,
    basePower: 6
  };

  assert.equal(getEffectiveCombatRequirement(lowPowerState, aiTile), 4);
  assert.equal(canExpandTo(lowPowerState, aiTile), false);
  assert.equal(canExpandTo(highPowerState, aiTile), true);
});

test("advanced mutation slots open at turn 20 and 40", () => {
  const beforeOpen = {
    ...createInitialState(),
    turn: 19,
    mutationPoints: 10
  };
  const beforeChoices = generateMutationChoices(beforeOpen);
  assert.equal(beforeChoices[2].type, "locked");
  assert.equal(beforeChoices[3].type, "locked");

  const firstOpen = {
    ...beforeOpen,
    turn: 20
  };
  const firstChoices = generateMutationChoices(firstOpen);
  assert.equal(firstChoices[2].type, "advanced");
  assert.equal(firstChoices[2].rarity, "rare");
  assert.equal(firstChoices[2].cost, 5);
  assert.equal(firstChoices[3].type, "locked");

  const secondOpen = {
    ...beforeOpen,
    turn: 40
  };
  const secondChoices = generateMutationChoices(secondOpen);
  assert.equal(secondChoices[3].type, "advanced");
  assert.equal(secondChoices[3].rarity, "rare");
  assert.equal(secondChoices[3].cost, 5);
});

test("free mutation choices do not spend mutation points and update basic stats", () => {
  let state = {
    ...createInitialState(),
    pendingMutationChoice: true,
    mutationPoints: 3
  };
  state = {
    ...state,
    mutationChoices: generateMutationChoices(state)
  };

  const next = chooseMutation(state, "basic_reproduction");

  assert.equal(next.reproduction, 2);
  assert.equal(next.mutationPoints, 3);
  assert.equal(next.pendingMutationChoice, false);
  assert.equal(next.currentSpeciesId, "primitive");
  assert.deepEqual(next.mutationAttributes, { power: 0, agility: 0, adaptation: 0 });
});

test("rare advanced mutations cost 5 points and increase their attribute", () => {
  let state = {
    ...createInitialState(),
    turn: 20,
    mutationPoints: 5,
    pendingMutationChoice: true
  };
  state = {
    ...state,
    mutationChoices: generateMutationChoices(state)
  };
  const rareChoice = state.mutationChoices[2];

  assert.equal(rareChoice.rarity, "rare");
  assert.equal(canChooseMutation(state, rareChoice.id), true);
  const next = chooseMutation(state, rareChoice.id);

  assert.equal(next.mutationPoints, 0);
  assert.equal(next.currentSpeciesId, rareChoice.id);
  assert.equal(next.unlockedMutationIds.includes(rareChoice.id), true);
  assert.equal(next.mutationAttributes[rareChoice.attribute], 1);
  assert.equal(
    Object.entries(next.mutationAttributes)
      .filter(([attribute]) => attribute !== rareChoice.attribute)
      .every(([, value]) => value === 0),
    true
  );
});

test("new rare power mutations are inherited as power attributes", () => {
  const newPowerMutationIds = ["desert_brood", "bloodless_assault", "mountain_hold"];
  const newPowerMutations = EVOLUTION_NODES.filter((node) => newPowerMutationIds.includes(node.id));

  assert.equal(newPowerMutations.length, 3);
  assert.equal(newPowerMutations.every((node) => node.rarity === "rare"), true);
  assert.equal(newPowerMutations.every((node) => node.attribute === "power"), true);

  const state = {
    ...createInitialState(),
    mutationPoints: 5,
    pendingMutationChoice: true,
    mutationChoices: [
      {
        id: "desert_brood",
        mutationId: "desert_brood",
        type: "advanced",
        cost: 5,
        rarity: "rare",
        attribute: "power"
      }
    ]
  };
  const next = chooseMutation(state, "desert_brood");

  assert.equal(next.mutationPoints, 0);
  assert.equal(next.unlockedMutationIds.includes("desert_brood"), true);
  assert.deepEqual(next.mutationAttributes, { power: 1, agility: 0, adaptation: 0 });
});

test("new power and agility mutations use their rarity, attributes, and immediate effects", () => {
  const agilityRareIds = ["wetland_brood", "nimble_advance", "water_settlement", "carnotaurus", "microraptor"];
  const agilityRareMutations = EVOLUTION_NODES.filter((node) => agilityRareIds.includes(node.id));
  assert.equal(agilityRareMutations.length, 5);
  assert.equal(agilityRareMutations.every((node) => node.rarity === "rare"), true);
  assert.equal(agilityRareMutations.every((node) => node.attribute === "agility"), true);
  assert.equal(agilityRareMutations.every((node) => node.mutationCost === 5), true);

  const lastStand = EVOLUTION_NODES.find((node) => node.id === "last_stand_surge");
  assert.equal(lastStand.rarity, "uncommon");
  assert.equal(lastStand.attribute, "power");

  const broodFocus = EVOLUTION_NODES.find((node) => node.id === "brood_focus");
  assert.equal(broodFocus.rarity, "uncommon");
  assert.equal(broodFocus.attribute, "agility");

  const lastStandState = {
    ...createInitialState(),
    population: 80,
    basePower: 12,
    mutationPoints: 10,
    pendingMutationChoice: true,
    mutationChoices: [
      {
        id: "last_stand_surge",
        mutationId: "last_stand_surge",
        type: "advanced",
        cost: 10,
        rarity: "uncommon",
        attribute: "power"
      }
    ]
  };
  const lastStandNext = chooseMutation(lastStandState, "last_stand_surge");
  assert.equal(lastStandNext.population, 1);
  assert.equal(lastStandNext.basePower, 62);
  assert.equal(lastStandNext.mutationPoints, 0);
  assert.equal(lastStandNext.mutationAttributes.power, 1);

  const broodFocusState = {
    ...createInitialState(),
    reproduction: 3,
    mutationPoints: 10,
    pendingMutationChoice: true,
    mutationChoices: [
      {
        id: "brood_focus",
        mutationId: "brood_focus",
        type: "advanced",
        cost: 10,
        rarity: "uncommon",
        attribute: "agility"
      }
    ]
  };
  const broodFocusNext = chooseMutation(broodFocusState, "brood_focus");
  assert.equal(broodFocusNext.reproduction, 23);
  assert.equal(broodFocusNext.mutationPoints, 0);
  assert.equal(broodFocusNext.mutationAttributes.agility, 1);
});

test("adaptation mutation pool replaces old adaptation nodes", () => {
  const oldAdaptationIds = ["spinosaurid", "coelurosaur", "spinosaurus", "yutyrannus"];
  const newRareIds = ["adaptive_mutation_gain_1", "adaptive_mutation_gain_2", "feather_growth", "quill_growth"];
  const newUncommonIds = ["flight_to_new_world"];
  const activeAdvancedIds = getAdvancedMutationNodes().map((node) => node.id);

  assert.equal(oldAdaptationIds.every((id) => !activeAdvancedIds.includes(id)), true);
  assert.equal(newRareIds.every((id) => activeAdvancedIds.includes(id)), true);
  assert.equal(newUncommonIds.every((id) => activeAdvancedIds.includes(id)), true);

  const newRareNodes = EVOLUTION_NODES.filter((node) => newRareIds.includes(node.id));
  assert.equal(newRareNodes.length, 4);
  assert.equal(newRareNodes.every((node) => node.rarity === "rare"), true);
  assert.equal(newRareNodes.every((node) => node.attribute === "adaptation"), true);
  assert.equal(newRareNodes.every((node) => node.mutationCost === 5), true);

  const flight = EVOLUTION_NODES.find((node) => node.id === "flight_to_new_world");
  assert.equal(flight.rarity, "uncommon");
  assert.equal(flight.attribute, "adaptation");
  assert.equal(flight.mutationCost, 10);
});

test("new adaptation mutations inherit adaptation and provide immediate numeric payoffs", () => {
  const featherState = {
    ...createInitialState(),
    mutationPoints: 5,
    pendingMutationChoice: true,
    mutationChoices: [
      {
        id: "feather_growth",
        mutationId: "feather_growth",
        type: "advanced",
        cost: 5,
        rarity: "rare",
        attribute: "adaptation"
      }
    ]
  };
  const featherNext = chooseMutation(featherState, "feather_growth");
  assert.equal(featherNext.mutationPoints, 0);
  assert.equal(featherNext.mutationAttributes.adaptation, 1);
  assert.equal(getPopulationGrowth(featherNext).featherGrowthExtra, 2);

  const freeChoiceState = {
    ...featherNext,
    pendingMutationChoice: true,
    mutationChoices: generateMutationChoices(featherNext)
  };
  const freeNext = chooseMutation(freeChoiceState, "basic_reproduction");
  assert.equal(freeNext.reproduction, 2);
  assert.equal(freeNext.population, featherNext.population);

  const quillState = withTiles(
    withMutations(createInitialState(), ["quill_growth"]),
    Array.from({ length: 4 }, (_, index) =>
      testTile({ key: `${index + 2},0`, q: index + 2, r: 0, terrain: "forest", owned: true })
    )
  );
  assert.equal(getPopulationMultiplier(quillState), 2);

  const flightState = {
    ...createInitialState(),
    mutationPoints: 10,
    mutationAttributes: { power: 0, agility: 0, adaptation: 6 },
    pendingMutationChoice: true,
    mutationChoices: [
      {
        id: "flight_to_new_world",
        mutationId: "flight_to_new_world",
        type: "advanced",
        cost: 10,
        rarity: "uncommon",
        attribute: "adaptation"
      }
    ]
  };
  const flightNext = chooseMutation(flightState, "flight_to_new_world");
  assert.equal(flightNext.mutationPoints, 2);
  assert.equal(flightNext.unlockedMutationIds.includes("flight_to_new_world"), true);
  assert.equal(flightNext.mutationAttributes.adaptation, 7);
});

test("adaptation mutation point gains stack on 5Ma cycle starts", () => {
  const baseCycle = advanceTurn({ ...createInitialState(), turn: 5, currentMa: 247, mutationPoints: 2 });
  assert.equal(baseCycle.turn, 6);
  assert.equal(baseCycle.mutationPoints, 3);

  const oneBonus = advanceTurn(
    withMutations({ ...createInitialState(), turn: 5, currentMa: 247, mutationPoints: 2 }, ["adaptive_mutation_gain_1"])
  );
  assert.equal(oneBonus.mutationPoints, 3.5);

  const twoBonus = advanceTurn(
    withMutations(
      { ...createInitialState(), turn: 5, currentMa: 247, mutationPoints: 2 },
      ["adaptive_mutation_gain_1", "adaptive_mutation_gain_2"]
    )
  );
  assert.equal(twoBonus.mutationPoints, 4);

  const flightBonus = advanceTurn(
    withMutations({ ...createInitialState(), turn: 5, currentMa: 247, mutationPoints: 2 }, ["flight_to_new_world"])
  );
  assert.equal(flightBonus.mutationPoints, 4);
});

test("fractional mutation points are hidden for purchasing until they reach a whole cost", () => {
  const lockedByHiddenHalf = {
    ...createInitialState(),
    turn: 20,
    mutationPoints: 4.5,
    pendingMutationChoice: true
  };
  const lockedChoices = generateMutationChoices(lockedByHiddenHalf);
  assert.equal(lockedChoices[2].available, false);
  assert.equal(canChooseMutation({ ...lockedByHiddenHalf, mutationChoices: lockedChoices }, lockedChoices[2].id), false);

  const unlockedByWholePoints = {
    ...lockedByHiddenHalf,
    mutationPoints: 5.5
  };
  const unlockedChoices = generateMutationChoices(unlockedByWholePoints);
  assert.equal(unlockedChoices[2].available, true);
  const next = chooseMutation({ ...unlockedByWholePoints, mutationChoices: unlockedChoices }, unlockedChoices[2].id);
  assert.equal(next.mutationPoints, 0.5);
});

test("uncommon mutations do not appear before their attribute reaches 3", () => {
  for (let seed = 1; seed < 100; seed += 1) {
    const state = {
      ...createInitialState(),
      seed,
      turn: 100,
      mutationPoints: 10,
      pendingMutationChoice: true,
      mutationAttributes: { power: 2, agility: 2, adaptation: 2 }
    };
    const mutationChoices = generateMutationChoices(state);
    assert.equal(mutationChoices.some((choice) => choice.type === "advanced" && choice.rarity === "uncommon"), false);
  }
});

test("uncommon mutations unlock only for attributes at 3 and cost 10", () => {
  let state = null;
  for (let seed = 1; seed < 1000; seed += 1) {
    const candidate = {
      ...createInitialState(),
      seed,
      turn: 100,
      mutationPoints: 10,
      pendingMutationChoice: true,
      mutationAttributes: { power: 3, agility: 0, adaptation: 0 }
    };
    const mutationChoices = generateMutationChoices(candidate);
    assert.equal(
      mutationChoices.some((choice) => choice.type === "advanced" && choice.rarity === "uncommon" && choice.attribute !== "power"),
      false
    );
    if (mutationChoices.some((choice) => choice.type === "advanced" && choice.rarity === "uncommon" && choice.attribute === "power")) {
      state = {
        ...candidate,
        mutationChoices
      };
      break;
    }
  }

  assert.notEqual(state, null);
  const uncommonChoice = state.mutationChoices.find((choice) => choice.type === "advanced" && choice.rarity === "uncommon");
  assert.equal(uncommonChoice.cost, 10);
  assert.equal(uncommonChoice.attribute, "power");
  const next = chooseMutation(state, uncommonChoice.id);

  assert.equal(next.mutationPoints, 0);
  assert.equal(next.unlockedMutationIds.includes(uncommonChoice.id), true);
  assert.equal(next.mutationAttributes.power, 4);
  assert.equal(next.mutationAttributes.agility, 0);
  assert.equal(next.mutationAttributes.adaptation, 0);
});

test("disabled giganotosaurus no longer allows equal-power expansion", () => {
  const tile = testTile({ combatRequired: 5, populationCost: 0 });
  const state = withTiles(
    withMutations({ ...createInitialState(), basePower: 5, population: 10 }, ["giganotosaurus"]),
    [tile]
  );

  assert.equal(getAdvancedMutationNodes().some((node) => node.id === "giganotosaurus"), false);
  assert.equal(canExpandTo(state, tile), false);
});

test("dromaeosaur first expansion each cycle does not consume the turn expansion", () => {
  const firstTile = testTile();
  const secondTile = testTile({ key: "-1,0", q: -1, r: 0 });
  let state = withTiles(
    withMutations({ ...createInitialState(), basePower: 20, population: 100 }, ["dromaeosaur"]),
    [firstTile, secondTile]
  );

  state = expandToTile(state, firstTile.key);
  assert.equal(state.hasExpandedThisTurn, false);
  assert.equal(state.cycleFreeExpansionUsed, true);

  state = expandToTile(state, secondTile.key);
  assert.equal(state.tiles.get(secondTile.key).owned, true);
  assert.equal(state.hasExpandedThisTurn, true);
});

test("UI expansion advance waits until the expansion count is spent", () => {
  const normalTile = testTile();
  const normalState = withTiles({ ...createInitialState(), basePower: 20, population: 100 }, [normalTile]);
  const normalExpanded = expandToTile(normalState, normalTile.key);
  const normalResolved = resolveExpandedTurnState(normalExpanded);

  assert.equal(normalExpanded.hasExpandedThisTurn, true);
  assert.equal(normalResolved.turn, 1);
  assert.equal(normalResolved.currentMa, 251);

  const firstTile = testTile();
  const secondTile = testTile({ key: "-1,0", q: -1, r: 0 });
  const dromaeosaurState = withTiles(
    withMutations({ ...createInitialState(), basePower: 20, population: 100 }, ["dromaeosaur"]),
    [firstTile, secondTile]
  );
  const firstExpanded = expandToTile(dromaeosaurState, firstTile.key);
  const firstResolved = resolveExpandedTurnState(firstExpanded);

  assert.equal(firstExpanded.hasExpandedThisTurn, false);
  assert.equal(firstResolved.turn, 0);
  assert.equal(firstResolved.currentMa, 252);

  const secondExpanded = expandToTile(firstResolved, secondTile.key);
  const secondResolved = resolveExpandedTurnState(secondExpanded);

  assert.equal(secondExpanded.hasExpandedThisTurn, true);
  assert.equal(secondResolved.turn, 1);
  assert.equal(secondResolved.currentMa, 251);
});

test("tyrannosaurus lowers the total power victory target", () => {
  const normalState = { ...createInitialState(), basePower: 99 };
  const state = withMutations({ ...createInitialState(), basePower: 50 }, ["tyrannosaurus"]);
  const result = checkVictory(state);

  assert.equal(getPowerVictoryTarget(normalState), 100);
  assert.equal(getPowerVictoryTarget(state), 50);
  assert.equal(result.type, "power");
});

test("population, terrain, and reveal abilities affect existing rules", () => {
  const grassland = testTile({ terrain: "grassland", combatRequired: 4, populationCost: 9 });
  const ambushState = withTiles(
    withMutations({ ...withoutAi(createInitialState()), basePower: 20, population: 20 }, ["herrerasaurus", "dilophosaurus"]),
    [grassland]
  );

  assert.equal(getEffectiveCombatRequirement(ambushState, grassland), 3);
  assert.equal(getEffectivePopulationCost(ambushState, grassland), 7);

  const aiTile = testTile({ key: "2,0", q: 2, r: 0, aiFactionId: 1, combatRequired: 4 });
  const aiState = withTiles(
    {
      ...ambushState,
      aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "2,0", population: 12, basePower: 4 }]
    },
    [aiTile]
  );
  assert.equal(getEffectiveCombatRequirement(aiState, aiTile), 4);

  const desert = testTile({ terrain: "desert", combatBonus: 1, owned: true });
  const ceratosaurusState = withTiles(withMutations(createInitialState(), ["ceratosaurus"]), [desert]);
  assert.equal(getTilePowerBonus(ceratosaurusState), 1);

  const secondDesert = testTile({ key: "2,0", q: 2, r: 0, terrain: "desert", combatBonus: 1, owned: true });
  const stackedCeratosaurusState = withTiles(withMutations(createInitialState(), ["ceratosaurus"]), [desert, secondDesert]);
  assert.equal(getTilePowerBonus(stackedCeratosaurusState), 3);

  const ownedGrassland = testTile({ terrain: "grassland", populationMultiplierDelta: 1, owned: true });
  const coelurosaurState = withTiles(withMutations(createInitialState(), ["coelurosaur"]), [ownedGrassland]);
  assert.equal(getPopulationMultiplier(coelurosaurState), 3);

  const scentTile = testTile({ key: "5,0", q: 5, r: 0, terrain: "forest", populationCost: 4 });
  const scentState = withTiles(withMutations(createInitialState(), ["tyrannosauroid"]), [scentTile]);
  assert.equal(getEffectivePopulationCost(scentState, scentTile), 3);
});

test("pack hunt grants power for every five owned tiles", () => {
  function stateWithExtraOwnedTiles(count) {
    const tiles = Array.from({ length: count }, (_, index) =>
      testTile({ key: `${index + 1},${index + 1}`, q: index + 1, r: index + 1, owned: true })
    );
    return withTiles(withMutations({ ...createInitialState(), basePower: 10 }, ["allosaurus"]), tiles);
  }

  assert.equal(getTotalPower(stateWithExtraOwnedTiles(3)), 10);
  assert.equal(getTotalPower(stateWithExtraOwnedTiles(4)), 11);
  assert.equal(getTotalPower(stateWithExtraOwnedTiles(9)), 12);
});

test("new power mutations affect desert growth, AI assaults, and mountain holdings", () => {
  const desert = testTile({ terrain: "desert", populationMultiplierDelta: -1, owned: true });
  const desertState = withTiles(withMutations(createInitialState(), ["desert_brood"]), [desert]);
  assert.equal(getPopulationMultiplier(desertState), 1);

  const grassland = testTile({ key: "1,1", q: 1, r: 1, terrain: "grassland", populationMultiplierDelta: 1, owned: true });
  const mixedTerrainState = withTiles(withMutations(createInitialState(), ["desert_brood"]), [desert, grassland]);
  assert.equal(getPopulationMultiplier(mixedTerrainState), 1);

  const normalTile = testTile({ key: "2,0", q: 2, r: 0, terrain: "forest", combatRequired: 1, populationCost: 4 });
  const normalState = withTiles(
    withMutations({ ...withoutAi(createInitialState()), basePower: 20, population: 20 }, ["bloodless_assault"]),
    [normalTile]
  );
  assert.equal(getExpansionPopulationCost(normalState, normalTile), 4);
  assert.equal(expandToTile(normalState, normalTile.key).population, 16);

  const aiTile = testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, combatRequired: 1, populationCost: 4 });
  const aiState = withTiles(
    withMutations(
      {
        ...withoutAi(createInitialState()),
        basePower: 20,
        population: 20,
        aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "3,0", population: 12, basePower: 1 }]
      },
      ["bloodless_assault"]
    ),
    [aiTile]
  );
  assert.equal(getExpansionPopulationCost(aiState, aiTile), 18);
  assert.equal(expandToTile(aiState, aiTile.key).population, 2);

  const mountain = testTile({
    key: "4,0",
    q: 4,
    r: 0,
    terrain: "mountain",
    conquerable: false,
    combatRequired: 0,
    populationCost: 0
  });
  const mountainState = withTiles(
    withMutations({ ...withoutAi(createInitialState()), basePower: 20, population: 20 }, ["mountain_hold"]),
    [mountain]
  );
  assert.equal(canExpandTo(mountainState, mountain), true);
  const expandedMountain = expandToTile(mountainState, mountain.key);
  assert.equal(expandedMountain.tiles.get(mountain.key).owned, true);
  assert.equal(getTilePowerBonus(expandedMountain), 1);
});

test("new agility rare mutations affect wetlands, combat requirements, and water settlement", () => {
  const grassland = testTile({ terrain: "grassland", populationMultiplierDelta: 1, owned: true });
  const wetlandState = withTiles(withMutations(createInitialState(), ["coelurosaur", "wetland_brood"]), [grassland]);
  assert.equal(getPopulationMultiplier(wetlandState), 4);

  const firstStrideTile = testTile({ key: "5,0", q: 5, r: 0, combatRequired: 1, populationCost: 8 });
  const secondStrideTile = testTile({ key: "6,0", q: 6, r: 0, combatRequired: 1, populationCost: 8 });
  const strideState = withTiles(
    withMutations(
      { ...withoutAi(createInitialState()), basePower: 20, population: 20, cycleExpansionCount: 0 },
      ["carnotaurus"]
    ),
    [firstStrideTile, secondStrideTile]
  );
  assert.equal(getEffectivePopulationCost(strideState, firstStrideTile), 0);
  const expandedStrideState = expandToTile(strideState, firstStrideTile.key);
  assert.equal(expandedStrideState.population, 20);
  assert.equal(getEffectivePopulationCost({ ...expandedStrideState, hasExpandedThisTurn: false }, secondStrideTile), 8);

  const normalTile = testTile({ combatRequired: 5, populationCost: 1 });
  const zeroTile = testTile({ key: "2,0", q: 2, r: 0, combatRequired: 0, populationCost: 1 });
  const aiTile = testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, combatRequired: 1, populationCost: 1 });
  const nimbleState = withTiles(
    withMutations(
      {
        ...withoutAi(createInitialState()),
        aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "3,0", population: 12, basePower: 4 }]
      },
      ["nimble_advance"]
    ),
    [normalTile, zeroTile, aiTile]
  );
  assert.equal(getEffectiveCombatRequirement(nimbleState, normalTile), 4);
  assert.equal(getEffectiveCombatRequirement(nimbleState, zeroTile), 0);
  assert.equal(getEffectiveCombatRequirement(nimbleState, aiTile), 3);

  const water = testTile({
    key: "4,0",
    q: 4,
    r: 0,
    terrain: "water",
    conquerable: false,
    combatRequired: 0,
    populationCost: 0
  });
  const waterState = withTiles(
    withMutations({ ...withoutAi(createInitialState()), basePower: 20, population: 20 }, ["water_settlement"]),
    [water]
  );
  assert.equal(canExpandTo(waterState, water), true);
  const expandedWater = expandToTile(waterState, water.key);
  assert.equal(expandedWater.tiles.get(water.key).owned, true);
  assert.equal(getPopulationMultiplier(expandedWater), 2);
});

test("brood focus blocks AI assaults but still allows ordinary expansion", () => {
  const normalTile = testTile({ key: "2,0", q: 2, r: 0, combatRequired: 1, populationCost: 1 });
  const aiTile = testTile({ key: "3,0", q: 3, r: 0, aiFactionId: 1, combatRequired: 1, populationCost: 1 });
  const state = withTiles(
    withMutations(
      {
        ...withoutAi(createInitialState()),
        basePower: 20,
        population: 20,
        aiFactions: [{ id: 1, waveIndex: 1, spawnTurn: 20, originKey: "3,0", population: 12, basePower: 1 }]
      },
      ["brood_focus", "bloodless_assault"]
    ),
    [normalTile, aiTile]
  );

  assert.equal(canExpandTo(state, normalTile), true);
  assert.equal(canExpandTo(state, aiTile), false);
  assert.equal(expandToTile(state, aiTile.key).tiles.get(aiTile.key).owned, false);
});

test("water passage and microraptor reveal extra map information without direct conquest", () => {
  const water = testTile({
    key: "1,0",
    q: 1,
    r: 0,
    terrain: "water",
    conquerable: false,
    combatRequired: 0,
    populationCost: 0
  });
  const acrossWater = testTile({ key: "2,0", q: 2, r: 0, terrain: "grassland" });
  let state = withTiles(withMutations(createInitialState(), ["spinosaurus"]), [water, acrossWater]);
  state = ensureVisibleTilesForState(state);

  // 涉水通道：水域背后的格子加入 scoutedKeys（可见但不可直接扩张），而非 visibleKeys。
  assert.equal(state.scoutedKeys.includes("2,0"), true);
  assert.equal(canExpandTo(state, water), false);

  const glideTile = testTile();
  state = withTiles(
    withMutations({ ...createInitialState(), basePower: 20, population: 100 }, ["microraptor"]),
    [glideTile]
  );
  state = expandToTile(state, glideTile.key);

  assert.equal(state.extraRevealedKeys.length, 2);
  assert.equal(
    getRecentTurnHistory(state, 1)[0].events.some((event) => event.text.includes("滑翔扩散额外揭示 2 格")),
    true
  );
});

test("victory uses population or total power", () => {
  const populationVictory = checkVictory({ ...createInitialState(), population: 40000, basePower: 1 });
  const totalPowerVictoryState = {
    ...createInitialState(),
    population: 10,
    basePower: 20,
    temporaryPowerBonus: 40,
    tiles: new Map([
      ["0,0", { key: "0,0", owned: true, combatBonus: 40, populationMultiplierDelta: 0 }]
    ])
  };
  const powerVictory = checkVictory(totalPowerVictoryState);

  assert.equal(populationVictory.type, "population");
  assert.equal(powerVictory.type, "power");
  assert.equal(getTotalPower(totalPowerVictoryState), 100);
});

test("flight to new world enables adaptation victory at the terminal check", () => {
  const adaptationVictory = checkVictory(
    withMutations(
      {
        ...createInitialState(),
        population: 10,
        basePower: 1,
        mutationAttributes: { power: 0, agility: 0, adaptation: 5 }
      },
      ["flight_to_new_world"]
    )
  );
  const missingKey = checkVictory({
    ...createInitialState(),
    population: 10,
    basePower: 1,
    mutationAttributes: { power: 0, agility: 0, adaptation: 5 }
  });
  const tooLow = checkVictory(
    withMutations(
      {
        ...createInitialState(),
        population: 10,
        basePower: 1,
        mutationAttributes: { power: 0, agility: 0, adaptation: 4 }
      },
      ["flight_to_new_world"]
    )
  );

  assert.equal(adaptationVictory.type, "adaptation");
  assert.equal(missingKey.type, "extinction");
  assert.equal(tooLow.type, "extinction");
});

test("adaptation victory takes priority over other victory routes", () => {
  const powerOverlap = checkVictory(
    withMutations(
      {
        ...createInitialState(),
        population: 10,
        basePower: 100,
        mutationAttributes: { power: 0, agility: 0, adaptation: 5 }
      },
      ["flight_to_new_world"]
    )
  );
  const populationOverlap = checkVictory(
    withMutations(
      {
        ...createInitialState(),
        population: 40000,
        basePower: 1,
        mutationAttributes: { power: 0, agility: 0, adaptation: 5 }
      },
      ["flight_to_new_world"]
    )
  );

  assert.equal(powerOverlap.type, "adaptation");
  assert.equal(populationOverlap.type, "adaptation");
});
