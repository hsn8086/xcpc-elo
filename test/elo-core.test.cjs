/**
 * Unit tests for the Elo core.
 *
 * These lock down the two properties the whole rating scale depends on:
 * shift invariance (a common offset must not change any delta) and the shape of
 * the first adjustment, which is now a single symmetric dial.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const CORE_PATH = path.resolve(__dirname, "..", "scripts", "lib", "elo-core.cjs");

/**
 * Loads elo-core with a specific environment, bypassing the module cache so the
 * configuration constants are re-read.
 *
 * @param {object} env Environment overrides.
 * @returns {object} Freshly loaded module.
 */
function loadCore(env) {
  delete require.cache[CORE_PATH];
  const saved = new Map();
  for (const [key, value] of Object.entries(env || {})) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  const loaded = require(CORE_PATH);
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return loaded;
}

/**
 * Builds a four-team contest.
 * @returns {object[]} Teams in rank order.
 */
function makeTeams() {
  return [
    { rank: 1, teamName: "A", members: ["a1", "a2", "a3"] },
    { rank: 2, teamName: "B", members: ["b1", "b2", "b3"] },
    { rank: 3, teamName: "C", members: ["c1", "c2", "c3"] },
    { rank: 4, teamName: "D", members: ["d1", "d2", "d3"] },
  ];
}

/**
 * Builds the matching player states, optionally shifted by a constant.
 * @param {number} offset Common offset added to every rating.
 * @returns {Map<string, object>} Player states.
 */
function makeStates(offset) {
  const spec = {
    a1: 1600, a2: 1550, a3: 1500,
    b1: 1500, b2: 1450, b3: 1400,
    c1: 1400, c2: 1350, c3: 1300,
    d1: 1300, d2: 1250, d3: 1200,
  };
  const states = new Map();
  for (const [id, rating] of Object.entries(spec)) {
    states.set(id, { id, rating: rating + offset, history: [[0, 1, 0, rating + offset]] });
  }
  return states;
}

/**
 * Runs one contest and returns the participant rows.
 * @param {object} core Loaded module.
 * @param {number} offset Rating offset.
 * @returns {object[]} Output rows.
 */
function runOnce(core, offset) {
  return core.applyCodeforcesUpdate(makeTeams(), makeStates(offset))[0];
}

test("a common rating offset changes no delta", () => {
  const core = loadCore({ XCPC_ELO_ADJUST_ALPHA: "0.5" });
  const base = runOnce(core, 0);
  const shifted = runOnce(core, 1000);
  assert.equal(base.length, shifted.length);
  for (let i = 0; i < base.length; i += 1) {
    assert.equal(
      base[i].delta,
      shifted[i].delta,
      `delta for ${base[i].id} must not depend on the absolute rating level`,
    );
  }
});

test("the same input produces the same output twice", () => {
  const core = loadCore({ XCPC_ELO_ADJUST_ALPHA: "0.5" });
  assert.deepEqual(runOnce(core, 0), runOnce(core, 0));
});

test("adjustAlpha 0 leaves the raw deltas untouched", () => {
  const core = loadCore({ XCPC_ELO_ADJUST_ALPHA: "0" });
  const [rows, statistics] = core.applyCodeforcesUpdate(makeTeams(), makeStates(0));
  assert.equal(statistics.adjustment1, 0);
  assert.equal(statistics.adjustment2, 0);
  // with no adjustment every delta must be exactly the raw update factor step
  for (const row of rows) {
    assert.equal(row.delta, Math.round((row.neededRating - row.rating) * 0.8));
  }
});

test("adjustAlpha 1 makes every contest balanced", () => {
  const core = loadCore({ XCPC_ELO_ADJUST_ALPHA: "1" });
  const [rows] = core.applyCodeforcesUpdate(makeTeams(), makeStates(0));
  const total = rows.reduce((sum, row) => sum + row.delta, 0);
  // rounding of the per-participant correction bounds this by half a point each
  assert.ok(Math.abs(total) <= rows.length / 2 + 1, `contest must be zero-sum, got ${total}`);
});

test("the second adjustment is disabled", () => {
  const core = loadCore({ XCPC_ELO_ADJUST_ALPHA: "0.5" });
  const [, statistics] = core.applyCodeforcesUpdate(makeTeams(), makeStates(0));
  assert.equal(statistics.adjustment2, 0);
});

test("both prediction metrics are reported", () => {
  const core = loadCore({ XCPC_ELO_ADJUST_ALPHA: "0.5" });
  const [, statistics] = core.applyCodeforcesUpdate(makeTeams(), makeStates(0));
  assert.ok(Number.isFinite(statistics.predictionSpearman), "rated-only Spearman must be finite");
  assert.ok(Number.isFinite(statistics.predictionSpearmanFull), "full-field Spearman must be finite");
  assert.equal(statistics.predictionTeamCount, 4);
  assert.equal(statistics.teamCount, 4);
});

test("midRanks shares the average rank across ties", () => {
  const core = loadCore({});
  assert.deepEqual(core.midRanks([2000, 1800, 1600, 1400]), [1, 2, 3, 4]);
  assert.deepEqual(core.midRanks([1400, 1400, 1400, 1400]), [2.5, 2.5, 2.5, 2.5]);
  assert.deepEqual(core.midRanks([1800, 1400, 1400]), [1, 2.5, 2.5]);
});

test("a fully tied prediction scores zero, not one", () => {
  const core = loadCore({});
  // This is the failure the full-field metric used to have: cold-start teams all
  // carry the same rating, a stable sort leaves them in rank order, and the plain
  // Spearman formula then reports a perfect correlation for a contest the model
  // knows nothing about.
  const tied = core.midRanks([1400, 1400, 1400, 1400]);
  assert.equal(core.pearsonOfRanks(tied, [1, 2, 3, 4]), 0);
});

test("rank correlation sign follows a correctly ordered prediction", () => {
  const core = loadCore({});
  const actual = [1, 2, 3, 4];
  assert.equal(core.pearsonOfRanks(core.midRanks([2000, 1800, 1600, 1400]), actual), 1);
  assert.equal(core.pearsonOfRanks(core.midRanks([1400, 1600, 1800, 2000]), actual), -1);
});

test("cold-start contests report no correlation instead of a fake one", () => {
  const core = loadCore({ XCPC_ELO_ADJUST_ALPHA: "0.5" });
  // Every member is new, so there is nothing to predict from.
  const teams = [
    { rank: 1, teamName: "A", members: ["a1", "a2", "a3"] },
    { rank: 2, teamName: "B", members: ["b1", "b2", "b3"] },
    { rank: 3, teamName: "C", members: ["c1", "c2", "c3"] },
  ];
  const states = new Map();
  for (const id of ["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3"]) {
    states.set(id, { id, rating: 1400, history: [] });
  }
  const [, statistics] = core.applyCodeforcesUpdate(teams, states);
  assert.equal(statistics.predictionTeamCount, 0);
  assert.equal(statistics.predictionSpearman, null);
  assert.equal(statistics.predictionSpearmanFull, 0);
  assert.equal(statistics.predictionStddev, null);
});
