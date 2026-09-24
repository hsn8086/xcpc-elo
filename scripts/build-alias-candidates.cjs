/**
 * Produces a review list of identities that may belong to the same person.
 *
 * A player's identity in this pipeline is the (organization, name) pair, so one
 * person who competes under several organizations becomes several entities that
 * each start from the initial rating. On the bundled data that splits at least
 * three top-20 entries in two or three, and no algorithm can undo it afterwards.
 *
 * Merging is never automatic. Name alone is not evidence: 刘洋 spans 27
 * organizations and almost all of those are different people. This script only
 * ranks candidates so a human can review a short list, and writes the result in
 * the exact shape data/aliases.json expects.
 *
 * Usage:
 *   node scripts/build-alias-candidates.cjs [out/teammate-map.json] [out/alias-candidates.json]
 */
const path = require("path");
const { readJson, writeJson } = require("./lib/ranklist-utils.cjs");

/**
 * Measures how informative the shared-teammate signal actually is.
 *
 * The data contains no per-person identifier, so no merge can be proven. One
 * direction is still sound, and it gives a control group: two identities that
 * appear in the same contest are definitely different people. Comparing the
 * shared-teammate rate of that control group against the unresolved pairs says how
 * much the signal is worth, instead of assuming it is worth something.
 *
 * @param {object[]} entries Teammate map entries.
 * @returns {object} Control-group statistics.
 */
function measureSignalStrength(entries) {
  const byName = new Map();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry);
  }

  let differentPairs = 0;
  let differentWithShared = 0;
  let candidatePairs = 0;
  let candidateWithShared = 0;

  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i += 1) {
      const coA = new Set(group[i].contests);
      const membersA = new Set(group[i].coMembers || []);
      for (let j = i + 1; j < group.length; j += 1) {
        const shared = (group[j].coMembers || []).some((name) => membersA.has(name));
        // Sharing a contest makes the pair provably different people.
        const provablyDifferent = group[j].contests.some((key) => coA.has(key));
        if (provablyDifferent) {
          differentPairs += 1;
          if (shared) differentWithShared += 1;
        } else {
          candidatePairs += 1;
          if (shared) candidateWithShared += 1;
        }
      }
    }
  }

  const controlRate = differentPairs > 0 ? differentWithShared / differentPairs : 0;
  const candidateRate = candidatePairs > 0 ? candidateWithShared / candidatePairs : 0;
  return {
    provablyDifferentPairs: differentPairs,
    provablyDifferentWithSharedTeammate: differentWithShared,
    controlRate,
    candidatePairs,
    candidateWithSharedTeammate: candidateWithShared,
    candidateRate,
    lift: controlRate > 0 ? candidateRate / controlRate : null,
    note:
      "The control group is pairs that appear in the same contest and are therefore definitely different people. " +
      "Any shared-teammate rate in that group is the false-positive floor, because a teammate is itself only a name.",
  };
}

/**
 * Scores how likely two identities are to be the same person.
 *
 * Shared co-members are the strong signal: two different people who share a name
 * rarely share teammates as well. Disjoint contest sets support it, because one
 * person cannot play two contests at the same time.
 *
 * @param {object} a First entry.
 * @param {object} b Second entry.
 * @returns {{score: number, sharedCoMembers: string[], sharedContests: string[]}} Evidence.
 */
function scorePair(a, b) {
  const coA = new Set(a.coMembers || []);
  const sharedCoMembers = (b.coMembers || []).filter((name) => coA.has(name));
  const contestA = new Set(a.contests || []);
  const sharedContests = (b.contests || []).filter((key) => contestA.has(key));
  const score = sharedCoMembers.length * 3 - sharedContests.length * 5;
  return { score, sharedCoMembers, sharedContests };
}

/**
 * Groups entries by member name and reports the ones that span organizations.
 *
 * @param {object} teammateMap Result of build-teammate-map.
 * @returns {object[]} Candidate groups, most impactful first.
 */
function buildCandidates(teammateMap) {
  const byName = new Map();
  for (const entry of teammateMap.entries || []) {
    if (!byName.has(entry.name)) {
      byName.set(entry.name, []);
    }
    byName.get(entry.name).push(entry);
  }

  const candidates = [];
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort((a, b) => b.appearances - a.appearances);
    let best = null;
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const evidence = scorePair(sorted[i], sorted[j]);
        if (!best || evidence.score > best.evidence.score) {
          best = { pair: [sorted[i], sorted[j]], evidence };
        }
      }
    }
    const appearances = sorted.reduce((sum, entry) => sum + entry.appearances, 0);
    candidates.push({
      name,
      organizations: sorted.map((entry) => entry.organization),
      appearances,
      entityCount: sorted.length,
      entries: sorted.map((entry) => ({
        organization: entry.organization,
        appearances: entry.appearances,
        contests: (entry.contests || []).length,
      })),
      bestPair: best
        ? {
            organizations: [best.pair[0].organization, best.pair[1].organization],
            score: best.evidence.score,
            sharedCoMembers: best.evidence.sharedCoMembers.slice(0, 8),
            sharedContests: best.evidence.sharedContests.slice(0, 8),
          }
        : null,
      // A non-negative score means the pair looks like one person; a negative one
      // means they were seen in the same contest and are therefore different people.
      suggestsMerge: Boolean(best && best.evidence.score > 0 && best.evidence.sharedContests.length === 0),
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.suggestsMerge) - Number(a.suggestsMerge) ||
      b.appearances - a.appearances ||
      a.name.localeCompare(b.name),
  );
  return candidates;
}

/**
 * Converts a candidate into the shape data/aliases.json expects.
 *
 * @param {object} candidate Candidate group.
 * @returns {object|null} Alias entry, or null when there is nothing to merge.
 */
function toAliasEntry(candidate) {
  if (!candidate.suggestsMerge || candidate.entries.length < 2) {
    return null;
  }
  const [canonical, ...rest] = candidate.entries;
  return {
    canonical: { organization: canonical.organization, name: candidate.name },
    aliases: rest.map((entry) => ({ organization: entry.organization, name: candidate.name })),
  };
}

/**
 * CLI entry point.
 */
function main() {
  const mapFile = path.resolve(process.argv[2] || path.join("out", "teammate-map.json"));
  const outputFile = path.resolve(process.argv[3] || path.join("out", "alias-candidates.json"));
  const teammateMap = readJson(mapFile);
  const candidates = buildCandidates(teammateMap);
  const suggested = candidates.filter((candidate) => candidate.suggestsMerge);
  const signal = measureSignalStrength(teammateMap.entries || []);

  writeJson(
    outputFile,
    {
      generatedAt: new Date().toISOString(),
      source: mapFile,
      totalCandidates: candidates.length,
      suggestedMerges: suggested.length,
      signalStrength: signal,
      note:
        "Review before copying into data/aliases.json. suggestsMerge is a heuristic, not a decision: the data has no " +
        "per-person identifier, so no merge can be proven. The one sound inference is the opposite direction, and " +
        "build-teammate-map.cjs refuses any merge whose identities share a contest.",
      candidates,
      suggestedAliasEntries: suggested.map(toAliasEntry).filter(Boolean),
    },
    true,
  );

  console.log(`Names spanning more than one organization: ${candidates.length}`);
  console.log(`Heuristically mergable: ${suggested.length}`);
  console.log(
    `Signal strength: control group (provably different people) shares a teammate name ${(signal.controlRate * 100).toFixed(1)}% ` +
      `of the time; unresolved pairs do so ${(signal.candidateRate * 100).toFixed(1)}% of the time` +
      (signal.lift == null ? "" : ` (${signal.lift.toFixed(1)}x lift)`),
  );
  console.log(`Wrote ${outputFile}`);
  console.log("\nTop review candidates:");
  for (const candidate of suggested.slice(0, 15)) {
    const orgs = candidate.entries.map((entry) => `${entry.organization}(${entry.appearances})`).join(" | ");
    const shared = candidate.bestPair && candidate.bestPair.sharedCoMembers.length > 0 ? ` shared teammates: ${candidate.bestPair.sharedCoMembers.slice(0, 3).join(",")}` : "";
    console.log(`  ${candidate.name.padEnd(6, "　")} ${String(candidate.appearances).padStart(4)} appearances  ${orgs}${shared}`);
  }
}

main();

module.exports = { buildCandidates, scorePair, toAliasEntry, measureSignalStrength };
