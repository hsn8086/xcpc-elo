/**
 * Builds the teammate-organization map used as Elo identity input.
 */
const path = require("path");
const {
  normalize,
  readJson,
  resolveText,
  teammateHashId,
  teammatePairKey,
  writeJson,
} = require("./lib/ranklist-utils.cjs");
const { loadAliases, resolveAlias, findMergeConflicts } = require("./lib/aliases.cjs");

/**
 * Scans static ranklists and aggregates teammate-organization pairs.
 *
 * @param {string} staticRootDir Directory containing static ranklists.
 * @param {string} outputFile Output JSON path.
 * @param {object} [options] Options.
 * @param {object} [options.aliases] Alias set from loadAliases, applied before identity hashing.
 * @returns {object} Built teammate map data.
 */
function buildTeammateOrganizationMap(staticRootDir, outputFile, options) {
  const aliases = (options && options.aliases) || loadAliases(null);
  const sourceMapFile = path.join(path.dirname(outputFile), "source-map.json");
  const sourceMap = readJson(sourceMapFile);
  const ranklistFiles = Object.keys(sourceMap).map((fileName) => path.join(staticRootDir, fileName));
  const pairMap = new Map();
  const aliasPairs = {};
  // Every raw (organization, name) pair seen, with the contests it appeared in.
  // Used to reject merges that are provably wrong.
  const contestsByPair = new Map();
  let mergedAppearances = 0;

  for (const filePath of ranklistFiles) {
    const data = readJson(filePath);
    const rows = Array.isArray(data && data.rows) ? data.rows : [];
    const contestKey = path.basename(filePath, ".static.srk.json");

    for (const row of rows) {
      const user = row && row.user ? row.user : {};
      const organization = normalize(resolveText(user.organization));
      const teamMembers = Array.isArray(user.teamMembers) ? user.teamMembers : [];
      if (!organization || !teamMembers.length) {
        continue;
      }

      for (const member of teamMembers) {
        const rawName = normalize(resolveText(member && member.name));
        if (!rawName) {
          continue;
        }

        // Identity is the (organization, name) pair, which fragments a person who
        // moves between organizations. The reviewed alias table folds those back
        // together before the id is derived, so the whole pipeline sees one entity.
        const rawKey = teammatePairKey(organization, rawName);
        if (!contestsByPair.has(rawKey)) {
          contestsByPair.set(rawKey, new Set());
        }
        contestsByPair.get(rawKey).add(contestKey);

        const identity = resolveAlias(aliases, organization, rawName);
        const name = identity.name;
        const key = teammatePairKey(identity.organization, name);
        if (identity.merged) {
          mergedAppearances += 1;
        }
        if (!pairMap.has(key)) {
          const id = teammateHashId(identity.organization, name);
          pairMap.set(key, {
            id,
            organization: identity.organization,
            name,
            contests: new Set(),
            coMembers: new Set(),
            appearances: 0,
          });
        }
        if (identity.merged) {
          // The alias pair must stay resolvable, otherwise the rater cannot tell
          // that (代码源, 蒋凌宇) is the same entity as (北京大学, 蒋凌宇) and would
          // register a fresh identity for it.
          aliasPairs[teammatePairKey(organization, rawName)] = pairMap.get(key).id;
        }

        const item = pairMap.get(key);
        item.appearances += 1;
        item.contests.add(contestKey);
        for (const other of teamMembers) {
          const otherName = normalize(resolveText(other && other.name));
          if (otherName && otherName !== rawName) {
            item.coMembers.add(otherName);
          }
        }
      }
    }
  }

  const conflicts = findMergeConflicts(aliases, contestsByPair);
  if (conflicts.length > 0) {
    const lines = conflicts.map(
      (c) => `  ${c.canonical}: ${c.left} vs ${c.right} share ${c.sharedContestCount} contest(s): ${c.sharedContests.join(", ")}`,
    );
    throw new Error(
      `data/aliases.json contains ${conflicts.length} impossible merge(s). Two identities that appear in the same contest are provably different people:\n${lines.join("\n")}`,
    );
  }

  const entries = [...pairMap.values()]
    .map((item) => ({
      id: item.id,
      organization: item.organization,
      name: item.name,
      appearances: item.appearances,
      contests: [...item.contests].sort(),
      coMembers: [...item.coMembers].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const mappingById = {};
  for (const entry of entries) {
    mappingById[entry.id] = {
      organization: entry.organization,
      name: entry.name,
      appearances: entry.appearances,
      contests: entry.contests,
      coMembers: entry.coMembers,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    staticRootDir,
    totalStaticRanklists: ranklistFiles.length,
    totalPairs: entries.length,
    aliasEntries: aliases.reviewedMerges.length,
    aliasEntriesSkipped: aliases.skippedMerges.length,
    mergedAppearances,
    aliasPairs,
    entries,
    mappingById,
  };

  writeJson(outputFile, output, true);
  return output;
}

/**
 * CLI entry point for teammate map generation.
 */
function main() {
  const staticRootDir = path.resolve(process.argv[2] || path.join("out", "static-ranklists"));
  const outputFile = path.resolve(process.argv[3] || path.join("out", "teammate-map.json"));
  const aliasFile = path.resolve(process.argv[4] || path.join("data", "aliases.json"));

  const aliases = loadAliases(aliasFile);
  const result = buildTeammateOrganizationMap(staticRootDir, outputFile, { aliases });
  console.log(`Scanned static ranklists: ${result.totalStaticRanklists}`);
  console.log(`Collected teammate-organization pairs: ${result.totalPairs}`);
  console.log(`Alias merges applied: ${result.aliasEntries} (${result.mergedAppearances} appearances folded)`);
  if (aliases.skippedMerges.length > 0) {
    console.log(`Alias merges skipped (missing "reviewed": true): ${aliases.skippedMerges.length}`);
    for (const name of aliases.skippedMerges.slice(0, 10)) {
      console.log(`  - ${name}`);
    }
  }
  console.log(`Saved mapping to: ${outputFile}`);
}

main();
