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
3. Compute Elo, then run the health checks  
   `npm run step:3:compute-elo`
4. Build frontend assets  
   `npm run step:4:build-frontend`

`npm run workflow:recompute-elo` is equivalent to steps 2, 3 and 4.

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

On the main 2023+ ICPC/CCPC contests the two are `0.7930` and `0.7415`, and across every contest they are `0.7386` and `0.5609`. The gap is entirely cold starts: reporting only the first number overstates how well a contest is actually predicted.

The full-field figure ranks tied predictions with mid-ranks and correlates rank vectors, rather than using `1 - 6*sum(d^2)/(n^3-n)`. That matters because cold-start teams all carry the initial rating, so in a contest with few rated teams the predicted order is mostly tie-breaking, and a stable sort leaves those ties in rank order. The naive formula scores such a contest at or near `1.0`. A contest that is entirely first-time participants would score a perfect correlation while the model knows nothing about any of them; it now reports `0`.

`npm run report:elo-metrics` prints both, and `--against` runs a paired bootstrap over per-contest scores so a change can be judged instead of eyeballed. A parameter change is only worth keeping when the 95% interval excludes zero.

## Identity

**A player is the `(organization, name)` pair. Nothing is merged.**

This is a deliberate limit, not an oversight. All 394 ranklists were checked for a
person-level identifier and there is none: `teamMembers[]` carries only `name`
(plus `role`, for coaches) across all 82,183 member records, and the `id` on a row
is a row number that appears in more than one contest only 19% of the time.

So both error directions are real and neither can be resolved from the data:

- one person competing under several organizations becomes several entities that
  each start from the initial rating;
- two different people with the same name at the same organization become a single
  entity.

The ambiguity is not rare. Within a *single* contest, the same name appears on more
than one team 10,727 times across 181 contests, which is the point: a name alone is
already insufficient before any cross-contest reasoning starts.

Merging identities was considered and rejected. The only sound inference the data
supports runs the other way — two identities that appear in the same contest are
*definitely* different people — and that can only falsify a merge, never justify
one. The tempting positive signal (shared teammates, disjoint contests) is real but
statistical: measured against a control group of provably different people, it has
a 0.3% false-positive floor and about a 20x lift, and it is self-referential because
a teammate is itself only a name. That is not a foundation for silently combining
people, so instead the pages report the ambiguity and let a reader judge:

- a `*` next to a name on the leaderboard means other entities share that name;
- the player page links to those entities, with their contest counts and ratings,
  so `蒋凌宇@北京大学`, `蒋凌宇@代码源` and `蒋凌宇@个人参赛` are all reachable
  from one another.

If the entries are later resolved by a human, the place to do it is the identity
function used by `build-teammate-map.cjs`; the rating code needs no changes.

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
- Elo data: `out/teammate-elo.json`
- Parameter sweep: `out/elo-experiment/results.csv`
- Frontend: `out/frontend/*`
