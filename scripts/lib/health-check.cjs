/**
 * Sanity checks over a finished Elo run.
 *
 * These exist because the rating level can drift for years without anything
 * visibly breaking: every individual page still renders, every player still has a
 * plausible looking number, and the only symptom is that the population no longer
 * averages the initial rating. That is exactly how the previous adjustment scheme
 * quietly removed 2.9 million rating points over a decade.
 *
 * The thresholds are deliberately loose. They are meant to catch a structural
 * regression, not to police normal fluctuation.
 */

/**
 * Default limits. Every one of them is expressed in rating points.
 */
const DEFAULT_LIMITS = {
  /** How far the mean final rating may sit from the initial rating. */
  meanRatingDrift: 60,
  /** Mean delta of a player's first ever contest. Cold starts are legitimately negative. */
  firstAppearanceDeltaMin: -70,
  firstAppearanceDeltaMax: 0,
  /** Mean delta per rating event across the whole population. */
  meanDeltaMagnitude: 80,
  /** No rating may leave this range. */
  maxAbsRating: 5000,
};

/**
 * Recomputes the population level from a finished Elo output.
 *
 * @param {object} output Result of compute-teammate-elo.
 * @returns {object} Derived health metrics.
 */
function summarizeEloOutput(output) {
  const initialRating = output.config.initialRating;
  const players = output.players || [];
  const contests = output.contests || [];

  var totalDelta = 0;
  var ratingEvents = 0;
  var firstAppearanceCount = 0;
  var firstAppearanceDeltaSum = 0;
  var finalRatingSum = 0;
  var maxAbs = 0;

  for (const player of players) {
    var running = initialRating;
    player.history.forEach((event, index) => {
      const delta = event[2];
      running += delta;
      totalDelta += delta;
      ratingEvents += 1;
      if (index === 0) {
        firstAppearanceCount += 1;
        firstAppearanceDeltaSum += delta;
      }
    });
    finalRatingSum += running;
    if (Math.abs(running) > maxAbs) {
      maxAbs = Math.abs(running);
    }
  }

  const meanRating = players.length > 0 ? finalRatingSum / players.length : initialRating;
  const firstAppearanceDelta = firstAppearanceCount > 0 ? firstAppearanceDeltaSum / firstAppearanceCount : 0;
  const meanDelta = ratingEvents > 0 ? totalDelta / ratingEvents : 0;
  const scored = contests.filter(
    (contest) => contest.statistics && Number.isFinite(contest.statistics.predictionSpearman),
  );
  const meanSpearman = scored.length > 0 ? scored.reduce((sum, c) => sum + c.statistics.predictionSpearman, 0) / scored.length : null;
  // Contests whose whole field is new cannot be predicted at all and yield no
  // finite Spearman; they are already excluded above and never averaged in.
  const meanSpearmanFull =
    scored.length > 0 ? scored.reduce((sum, c) => sum + (c.statistics.predictionSpearmanFull || 0), 0) / scored.length : null;

  return {
    initialRating,
    players: players.length,
    contests: contests.length,
    ratingEvents,
    totalDelta,
    meanDelta,
    meanRating,
    ratingDrift: meanRating - initialRating,
    firstAppearanceDelta,
    maxAbsRating: maxAbs,
    meanSpearman,
    meanSpearmanFull,
    scoredContests: scored.length,
  };
}

/**
 * Runs the health checks.
 *
 * @param {object} output Result of compute-teammate-elo.
 * @param {object} [limits] Overrides for DEFAULT_LIMITS.
 * @returns {{ok: boolean, metrics: object, checks: object[]}} Check report.
 */
function checkEloHealth(output, limits) {
  const effective = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const metrics = summarizeEloOutput(output);
  const checks = [];

  const push = (name, ok, detail) => {
    checks.push({ name, ok, detail });
  };

  push(
    "mean-rating-drift",
    Math.abs(metrics.ratingDrift) <= effective.meanRatingDrift,
    `mean final rating ${metrics.meanRating.toFixed(1)} vs initial ${metrics.initialRating} (drift ${metrics.ratingDrift >= 0 ? "+" : ""}${metrics.ratingDrift.toFixed(1)}, limit +/-${effective.meanRatingDrift})`,
  );
  push(
    "first-appearance-delta",
    metrics.firstAppearanceDelta >= effective.firstAppearanceDeltaMin && metrics.firstAppearanceDelta <= effective.firstAppearanceDeltaMax,
    `mean delta of a first contest ${metrics.firstAppearanceDelta.toFixed(1)} (limit ${effective.firstAppearanceDeltaMin}..${effective.firstAppearanceDeltaMax})`,
  );
  push(
    "mean-delta",
    Math.abs(metrics.meanDelta) <= effective.meanDeltaMagnitude,
    `mean delta per rating event ${metrics.meanDelta.toFixed(2)} (limit +/-${effective.meanDeltaMagnitude})`,
  );
  push("rating-range", metrics.maxAbsRating <= effective.maxAbsRating, `max |rating| ${metrics.maxAbsRating.toFixed(0)} (limit ${effective.maxAbsRating})`);
  push("events-present", metrics.ratingEvents > 0, `${metrics.ratingEvents} rating events`);
  push(
    "spearman-present",
    Number.isFinite(metrics.meanSpearman),
    `mean rated-only Spearman ${metrics.meanSpearman == null ? "n/a" : metrics.meanSpearman.toFixed(4)} over ${metrics.scoredContests} contests`,
  );

  return { ok: checks.every((check) => check.ok), metrics, checks };
}

/**
 * Formats a check report for a log.
 *
 * @param {object} report Result of checkEloHealth.
 * @returns {string} Human readable report.
 */
function formatHealthReport(report) {
  const lines = ["Elo health:"];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(22)} ${check.detail}`);
  }
  const m = report.metrics;
  lines.push(
    `  info prediction quality           rated-only ${m.meanSpearman == null ? "-" : m.meanSpearman.toFixed(4)} over ${m.scoredContests} contests, full field ${m.meanSpearmanFull == null ? "-" : m.meanSpearmanFull.toFixed(4)}`,
  );
  return lines.join("\n");
}

module.exports = {
  DEFAULT_LIMITS,
  summarizeEloOutput,
  checkEloHealth,
  formatHealthReport,
};
