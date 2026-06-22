import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../src/gameState.js";
import { advanceTurn } from "../src/rules.js";
import {
  SAVE_VERSION,
  clearLatestServerSave,
  clearSaveGame,
  deserializeState,
  hasSaveGame,
  hasSaveGameOnServer,
  loadGame,
  loadGameFromServer,
  saveGame,
  saveGameToServer,
  serializeState
} from "../src/saveGame.js";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    firstKey() {
      return values.keys().next().value;
    }
  };
}

function withStorage(callback) {
  const previousStorage = globalThis.localStorage;
  const storage = createStorage();
  globalThis.localStorage = storage;

  try {
    return callback(storage);
  } finally {
    if (previousStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousStorage;
    }
  }
}

async function withGlobalValue(name, value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value
  });

  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
}

test("serializes and restores initial state tiles as a Map", () => {
  const state = createInitialState({ seed: 1234 });
  const restored = deserializeState(serializeState(state));

  assert.notEqual(restored, null);
  assert.equal(restored.tiles instanceof Map, true);
  assert.equal(restored.tiles.size, state.tiles.size);
  assert.deepEqual(restored.tiles.get("0,0"), state.tiles.get("0,0"));
  assert.equal(restored.seed, 1234);
});

test("preserves mutation choice, AI, notices, and logs across round trip", () => {
  const state = {
    ...advanceTurn(createInitialState({ seed: 42 })),
    notices: [{ type: "test-notice", title: "Notice" }],
    log: ["251 Ma：测试日志"]
  };
  const restored = deserializeState(serializeState(state));

  assert.notEqual(restored, null);
  assert.equal(restored.pendingMutationChoice, true);
  assert.equal(restored.mutationChoices.length, 4);
  assert.deepEqual(restored.aiFactions, state.aiFactions);
  assert.deepEqual(restored.notices, state.notices);
  assert.deepEqual(restored.log, state.log);
});

test("restored state can continue through rules", () => {
  const restored = deserializeState(serializeState(createInitialState({ seed: 99 })));
  const next = advanceTurn(restored);

  assert.equal(next.turn, 1);
  assert.equal(next.pendingMutationChoice, true);
  assert.equal(next.tiles instanceof Map, true);
});

test("loadGame returns null for damaged, wrong-version, or incomplete saves", () => {
  withStorage((storage) => {
    assert.equal(saveGame(createInitialState({ seed: 7 })), true);
    const key = storage.firstKey();

    storage.setItem(key, "{bad json");
    assert.equal(loadGame(), null);
    assert.equal(hasSaveGame(), false);

    storage.setItem(key, JSON.stringify({ version: SAVE_VERSION + 1, state: {} }));
    assert.equal(loadGame(), null);

    storage.setItem(
      key,
      JSON.stringify({
        version: SAVE_VERSION,
        state: { seed: 1, turn: 0, currentMa: 252 }
      })
    );
    assert.equal(loadGame(), null);
  });
});

test("saveGame, hasSaveGame, loadGame, and clearSaveGame use localStorage", () => {
  withStorage(() => {
    const state = createInitialState({ seed: 555 });

    assert.equal(hasSaveGame(), false);
    assert.equal(saveGame(state), true);
    assert.equal(hasSaveGame(), true);

    const loaded = loadGame();
    assert.notEqual(loaded, null);
    assert.equal(loaded.seed, 555);
    assert.equal(loaded.tiles instanceof Map, true);

    assert.equal(clearSaveGame(), true);
    assert.equal(hasSaveGame(), false);
  });
});

test("server save API is skipped on GitHub Pages", async () => {
  let fetchCalled = false;
  const location = {
    protocol: "https:",
    hostname: "2n4rgdmy89-rgb.github.io",
    port: ""
  };
  const fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ saves: [] }) };
  };

  await withGlobalValue("location", location, async () => {
    await withGlobalValue("fetch", fetch, async () => {
      const state = createInitialState({ seed: 123 });

      assert.equal(await saveGameToServer(state), null);
      assert.equal(await loadGameFromServer(), null);
      assert.equal(await hasSaveGameOnServer(), false);
      assert.equal(await clearLatestServerSave(), false);
      assert.equal(fetchCalled, false);
    });
  });
});
