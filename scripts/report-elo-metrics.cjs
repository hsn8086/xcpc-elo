/**
 * Reports the prediction quality of a finished Elo run, with a paired bootstrap
 * against another run.
 *
 * Two numbers are always reported, because they answer different questions:
 *
 *   rated-only  same as the historical headline: only teams that already had
 *               contest history are ranked and compared. This is the easy subset.
 *   full field  every team counts, including the cold-start ones the model has no
 *               information about. This is what a user sees on a fresh contest page.
 *
 * Usage:
 *   node scripts/report-elo-metrics.cjs out/teammate-elo.json
 *   node scripts/report-elo-metrics.cjs out/candidate.json --against out/teammate-elo.json
 */
const path = require("path");
const { readJson } = require("./lib/ranklist-utils.cjs");

/**
 * Decides whether a contest belongs to the main-scoring population.
 *
 * Unrated contests are excluded because their stored ratings are omitted, and
 * invitational / preliminary / Hong Kong contests are excluded because they are
 * not part of the main series.
 *
 * @param {object} contest Contest row of an Elo output.
 * @returns {boolean} True for main, rated ICPC/CCPC contests of 2023 and later.
 */
function isScoredContest(contest) {
  const year = contest.startAt ? new Date(contest.startAt).getFullYear() : 0;
  const haystack = `${contest.key || ""} ${contest.sourcePath || ""} ${contest.title || ""}`;
  return (
    !contest.unrated &&
    year >= 2023 &&
    /^(icpc|ccpc)\//i.test(contest.sourcePath || "") &&
    !/invitational|preliminary|hongkong/i.test(haystack)
  );
}

/**
 * Collects the per-contest metrics of a run.
 *
 * @param {object} output Elo output.
 * @returns {object[]} One entry per scored contest.
 */
function collectContestMetrics(output) {
  const rows = [];
  for (const contest of output.contests || []) {
    if (!isScoredContest(contest)) continue;
    const statistics = contest.statistics;
    if (!statistics) continue;
    rows.push({
      key: contest.key,
      startAt: contest.startAt,
      ratedOnly: Number.isFinite(statistics.predictionSpearman) ? statistics.predictionSpearman : null,
      fullField: Number.isFinite(statistics.predictionSpearmanFull) ? statistics.predictionSpearmanFull : null,
      teamCount: statistics.teamCount,
      ratedTeamCount: statistics.predictionTeamCount,
    });
  }
  return rows;
}

/**
 * Computes the macro mean of a per-contest series, skipping missing entries.
 *
 * @param {object[]} rows Per-contest metrics.
 * @param {string} field Field to average.
 * @returns {number} Macro mean, or NaN when nothing is available.
 */
function macroMean(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => Number.isFinite(value));
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Paired bootstrap over the per-contest differences of two runs.
 *
 * @param {object[]} a Candidate rows.
 * @param {object[]} b Baseline rows.
 * @param {string} field Field to compare.
 * @param {number} resamples Number of bootstrap resamples.
 * @returns {{delta: number, lo: number, hi: number, n: number}} Mean difference and 95% interval.
 */
function pairedBootstrap(a, b, field, resamples) {
  const index = new Map(b.map((row) => [row.key, row]));
  const diffs = [];
  for (const row of a) {
    const other = index.get(row.key);
    if (!other) continue;
    if (!Number.isFinite(row[field]) || !Number.isFinite(other[field])) continue;
    diffs.push(row[field] - other[field]);
  }
  if (diffs.length === 0) return { delta: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0 };
  const delta = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const samples = [];
  for (let i = 0; i < resamples; i += 1) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j += 1) {
      sum += diffs[Math.floor(Math.random() * diffs.length)];
    }
    samples.push(sum / diffs.length);
  }
  samples.sort((x, y) => x - y);
  return {
    delta,
    lo: samples[Math.floor(resamples * 0.025)],
    hi: samples[Math.floor(resamples * 0.975)],
    n: diffs.length,
  };
}

/**
 * Formats a signed number with a fixed precision.
 * @param {number} value Value.
 * @param {number} digits Decimals.
 * @returns {string} Formatted value.
 */
function signed(value, digits) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/**
 * CLI entry point.
 */
function main() {
  const args = process.argv.slice(2);
  const inputFile = path.resolve(args.find((arg) => !arg.startsWith("--")) || path.join("out", "teammate-elo.json"));
  const againstIndex = args.indexOf("--against");
  const baselineFile = againstIndex >= 0 ? path.resolve(args[againstIndex + 1]) : null;
  const resampleIndex = args.indexOf("--bootstrap");
  const resamples = resampleIndex >= 0 ? Number.parseInt(args[resampleIndex + 1], 10) : 5000;

  const output = readJson(inputFile);
  const rows = collectContestMetrics(output);
  const config = output.config || {};
  console.log(`file: ${path.relative(process.cwd(), inputFile)}`);
  console.log(
    `config: initialRating=${config.initialRating} scale=${config.eloScale} updateFactor=${config.eloUpdateFactor} ` +
      `aggregation=${config.teamRatingAggregation} adjustAlpha=${config.adjustAlpha}`,
  );
  console.log(`scored contests: ${rows.length}`);
  console.log(`  rated-only Spearman (macro mean): ${macroMean(rows, "ratedOnly").toFixed(4)}`);
  console.log(`  full-field Spearman (macro mean): ${macroMean(rows, "fullField").toFixed(4)}`);

  if (!baselineFile) return;
  const baseline = collectContestMetrics(readJson(baselineFile));
  console.log(`\npaired bootstrap vs ${path.relative(process.cwd(), baselineFile)} (${resamples} resamples)`);
  for (const field of ["ratedOnly", "fullField"]) {
    const result = pairedBootstrap(rows, baseline, field, resamples);
    const verdict =
      result.lo > 0 ? "better" : result.hi < 0 ? "worse" : "indistinguishable";
    console.log(
      `  ${field.padEnd(10)} delta ${signed(result.delta, 4)}  [${signed(result.lo, 4)}, ${signed(result.hi, 4)}]  n=${result.n}  ${verdict}`,
    );
  }
}

main();

module.exports = { isScoredContest, collectContestMetrics, macroMean, pairedBootstrap };
