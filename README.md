# xcpc-elo

Pipeline utilities for building an XCPC teammate Elo dashboard from [algoux/srk-collection](https://github.com/algoux/srk-collection) ranklists.

## Setup

```bash
npm install
```

## Canonical Workflow

```bash
npm run workflow:elo-dashboard
```

This runs the full workflow in order:

1. SRK source -> static ranklists  
   `npm run step:1:static-ranklists`
2. Extract teammate-organization map  
   `npm run step:2:teammate-org-map`
3. Suggest identity merges for review (does not modify anything)  
   `npm run step:2c:alias-candidates`
4. Compute Elo, then run the health checks  
   `npm run step:3:compute-elo`
5. Build frontend assets  
   `npm run step:4:build-frontend`

`npm run workflow:recompute-elo` is equivalent to steps 2, 4 and 5.

```bash
npm test                                  # unit tests
npm run report:elo-metrics                # prediction quality of the current run
npm run report:elo-metrics -- <candidate> --against out/teammate-elo.json
```

## Rating Model

Each player is identified by the `(organization, name)` pair. A team's rating is the log-power-mean of its members **that already have contest history**; members without history do not contribute to the team rating at all. Teams without any rated member are anchored by interpolating between the nearest rated teams around their finishing rank, so a first contest still produces a sensible rating.

Each member is pulled toward the team's needed rating by `updateFactor` (0.8). Note what that implies: teammates on a stable roster converge to the same number, and after a few shared contests they are usually identical. This is not a bug — the contest result carries no per-member information, so teammates genuinely cannot be told apart — but it does mean a leaderboard can legitimately show three members of one team on the exact same rating. The player page reports how often this happened as `与队友同分 N/M 场`.

### The adjustment knob

`ELO_ADJUST_ALPHA` decides what happens to the surplus the raw deltas leave behind. Raw deltas are not zero-sum: teams of first-time participants finish below the median, so they lose more than returning participants gain.

| `ELO_ADJUST_ALPHA` | Behaviour | Rank correlation | Mean rating after 10 years |
| --- | --- | --- | --- |
| `0` | leave the surplus alone | best | drifts up (~+30) |
| `0.5` | **default** | on par with or better than the old scheme | ~+15 |
| `1` | exact zero-sum | worst | exactly pinned to `initialRating` |

The previous scheme was `clamp(trunc(-sumDelta/n) - 1, -10000, 0)`. It was clamped to non-positive values, so contests that lost rating in the raw step could never be balanced back, and the whole system drained about 2.9 million rating points over a decade. Turning it off is a Pareto improvement: better rank correlation, better calibration, and the mean delta of a first contest falls from −89 to −44.

`initialRating` is *not* a calibration knob. The update only ever depends on rating differences, so shifting every rating by a constant changes no delta and no metric — verified in the test suite. Moving it changes the label and nothing else.

### Prediction quality

Two numbers are always reported, because they answer different questions:

- **rated-only** — only teams that already had contest history. This is the historical headline number.
- **full field** — every team, including cold-start teams the model has no information about. This is what a reader of a contest page actually sees.

On the bundled data the two differ by roughly 0.04 (`0.79` vs `0.75` per contest), because about a fifth of all team entries are cold starts. Reporting only the first one overstates how well the model predicts a contest.

`npm run report:elo-metrics` prints both, and `--against` runs a paired bootstrap over per-contest scores so a change can be judged instead of eyeballed. A parameter change is only worth keeping when the 95% interval excludes zero.

## Identity

**The data contains no per-person identifier.** All 394 ranklists were checked: `teamMembers[]` carries only `name` (plus `role` for coaches), and `user.id` is a row number that appears in more than one contest only 19% of the time. Identity therefore has to be the `(organization, name)` pair, which is wrong in both directions:

- one person competing under several organizations becomes several entities that each start from the initial rating;
- two different people with the same name at the same organization become one entity.

The scale of the ambiguity is measurable: within a *single* contest, the same name appears on more than one team 10,727 times across 181 contests.

`data/aliases.json` merges identities across organizations. Two rules apply:

1. **A merge only takes effect with `"reviewed": true`.** Without it the entry is listed as skipped and ignored. A merge is always an editorial claim about who somebody is, so it should be a deliberate one.
2. **A merge whose identities ever appear in the same contest is rejected.** One person cannot play for two teams in one contest, so such a pair is provably different people. This check is the only sound inference the data supports, and it fails the build rather than corrupting the ratings silently.

`npm run step:2c:alias-candidates` writes `out/alias-candidates.json` to make the review short. It ranks candidates by shared teammates and reports how much that signal is actually worth, using a control group: identities that are *provably* different people share a teammate name 0.3% of the time, while unresolved candidate pairs do so 7.6% of the time. That is a 20x lift and a useful ordering, but it is not proof — a teammate is itself only a name, which is what the 0.3% floor measures. Treat the list as reading material for a human decision.

## Health Checks

`step:3` asserts the run is sane and exits non-zero when it is not. This exists because the failure mode is invisible: every page still renders, every player still has a plausible number, and the only symptom is that the population no longer averages the initial rating.

| Check | Limit |
| --- | --- |
| mean final rating vs `initialRating` | ±60 |
| mean delta of a first contest | −70 … 0 |
| mean delta per rating event | ±80 |
| max absolute rating | 5000 |

Set `XCPC_ELO_SKIP_HEALTH=1` to bypass (for example while sweeping parameters).

## Predict Ranking From Registration CSV

Use `scripts/predict-ranking.cjs` to estimate team ranking from teammate Elo.

The CSV file should have the following columns:
- `school|university|学校|院校|organization`
- `[teammate|队员|member]<1|2|3>` (at least one teammate column is required)

Unmatched teammates are ignored when aggregating Elo. If a team has no matched teammates, its predicted score is `0`, so it falls to the bottom of the predicted ranking.

The input CSV encoding is auto-detected, and the generated output CSV is written using the same encoding and BOM behavior as the input file.

```bash
node scripts/predict-ranking.cjs <input.csv> [output.csv] [elo.json] [--mode sum|max|mean|geometric-mean]
```

Examples:

```bash
# Default mode is sum.
node scripts/predict-ranking.cjs icpc-xian.csv

# Use max teammate rating instead of rating sum.
node scripts/predict-ranking.cjs icpc-xian.csv --mode max

# Average teammate ratings.
node scripts/predict-ranking.cjs icpc-xian.csv --mode mean

# Use the geometric mean of teammate ratings.
node scripts/predict-ranking.cjs icpc-xian.csv --mode geometric-mean
```

Arguments:

- `input.csv`: Registration CSV to predict.
- `output.csv` (optional): Output path, default is `<input>.predicted.csv`.
- `elo.json` (optional): Elo source JSON, default is `out/teammate-elo.json`.
- `--mode` (optional): `sum`, `max`, `mean`, or `geometric-mean`.

## Parameter Search

`npm run experiment:elo-parameters` sweeps `updateFactor` against `ELO_ADJUST_ALPHA` and writes `out/elo-experiment/results.csv`. Each row carries both the prediction metrics and the rating-drift figures, because prediction metrics are invariant to a common rating offset and cannot reveal inflation on their own.

Two knobs do not need sweeping, and the sweep no longer tries:

- `ELO_SEED_RANK_RADIUS` is a no-op. The largest contest has about 2,500 teams, and the radius only gates interpolation branches that are always taken below that size.
- The second adjustment (over the highest rated participants) is disabled. Every configuration that switches it on scores measurably worse.

The plugin point for changing the shape of the schedule is `scripts/lib/elo-core.cjs`; `test/elo-core.test.cjs` pins the properties that must hold.

## Key Outputs

- Invalid teammate report: `out/_invalid-teammates.json`
- Teammate map: `out/teammate-map.json`
- Identity candidates for review: `out/alias-candidates.json`
- Elo data: `out/teammate-elo.json`
- Parameter sweep: `out/elo-experiment/results.csv`
- Frontend: `out/frontend/*`
