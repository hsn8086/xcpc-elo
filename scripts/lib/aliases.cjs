/**
 * Identity merging.
 *
 * A player's identity in this pipeline is the (organization, name) pair. That is
 * wrong in both directions: the same person appears as several entities when they
 * switch between a school, a company, and 个人参赛, and two different people share
 * an entity when they share a common name at the same organization.
 *
 * This module handles the first direction only, and only from an explicitly
 * reviewed table. Automatic merging is deliberately not attempted: a name like
 * 刘洋 legitimately spans 27 organizations and most of those are different people.
 *
 * The second direction cannot be fixed from the available data and is instead
 * surfaced by scripts/build-alias-candidates.cjs for human review.
 */
const fs = require("fs");

const PAIR_SEPARATOR = "\u0001";

/**
 * Builds the empty alias set.
 * @returns {object} Alias set with no merges.
 */
function emptyAliases() {
  return { merges: [], reviewedMerges: [], skippedMerges: [], lookup: new Map(), aliasCount: 0 };
}

/**
 * Reads the identity table.
 *
 * The file is optional: a missing or empty table means no merging, which is the
 * behaviour the project had before aliases existed.
 *
 * Merges only take effect when they carry `"reviewed": true`. That default is
 * deliberate. The data contains no per-person identifier, so a merge cannot be
 * derived from the ranklists: it is always an editorial claim about who somebody
 * is, and it should be a deliberate one rather than a side effect of regenerating
 * a file.
 *
 * @param {string} file Path to data/aliases.json.
 * @returns {object} Loaded alias set.
 */
function loadAliases(file) {
  if (!file || !fs.existsSync(file)) {
    return emptyAliases();
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const merges = Array.isArray(raw && raw.merges) ? raw.merges : [];
  const lookup = new Map();
  const reviewedMerges = [];
  const skippedMerges = [];
  let aliasCount = 0;

  for (const merge of merges) {
    const canonical = merge && merge.canonical;
    if (!canonical || !canonical.organization || !canonical.name) {
      throw new Error(`alias entry is missing canonical.organization / canonical.name: ${JSON.stringify(merge)}`);
    }
    if (merge.reviewed !== true) {
      skippedMerges.push(`${canonical.organization} / ${canonical.name}`);
      continue;
    }
    const target = { organization: canonical.organization, name: canonical.name };
    const aliases = Array.isArray(merge.aliases) ? merge.aliases : [];
    for (const alias of aliases) {
      if (!alias || !alias.organization || !alias.name) {
        throw new Error(`alias entry is missing organization / name: ${JSON.stringify(alias)}`);
      }
      const key = `${alias.organization}${PAIR_SEPARATOR}${alias.name}`;
      const existing = lookup.get(key);
      if (existing && (existing.organization !== target.organization || existing.name !== target.name)) {
        throw new Error(
          `identity ${alias.organization} / ${alias.name} is claimed by two different canonical entries: ` +
            `${existing.organization} / ${existing.name} and ${target.organization} / ${target.name}`,
        );
      }
      lookup.set(key, target);
      aliasCount += 1;
    }
    reviewedMerges.push(merge);
  }

  return { merges, reviewedMerges, skippedMerges, lookup, aliasCount };
}

/**
 * Resolves an (organization, name) pair to its canonical identity.
 *
 * @param {object} aliases Alias set from loadAliases.
 * @param {string} organization Organization.
 * @param {string} name Member name.
 * @returns {{organization: string, name: string, merged: boolean}} Canonical identity.
 */
function resolveAlias(aliases, organization, name) {
  const target = aliases.lookup.get(`${organization}${PAIR_SEPARATOR}${name}`);
  if (!target) {
    return { organization, name, merged: false };
  }
  return { organization: target.organization, name: target.name, merged: true };
}

/**
 * Rejects merges that are provably wrong.
 *
 * The data contains no per-person identifier, so no merge can be proven correct.
 * One direction is still sound: a single person cannot appear on two teams of the
 * same contest, so if two identities share a contest they are definitely different
 * people. This check turns that into a hard failure instead of a silent corruption.
 *
 * It is worth having because the only positive evidence available (shared
 * teammates, disjoint contests) is statistical. Its strength is measurable: on the
 * bundled data, identities that are provably different share a teammate name 0.3%
 * of the time, while unresolved candidate pairs do so 7.6% of the time. That is a
 * 20x lift and a useful ranking signal, but it is not a proof, and this check is
 * the part that is a proof.
 *
 * @param {object} aliases Alias set from loadAliases.
 * @param {Map<string, Set<string>>} contestsByPair Contest keys seen per (organization, name).
 * @returns {object[]} One conflict per provably wrong merge.
 */
function findMergeConflicts(aliases, contestsByPair) {
  const conflicts = [];
  for (const merge of aliases.reviewedMerges || []) {
    const canonical = merge.canonical;
    const identities = [canonical, ...(merge.aliases || [])];
    for (let i = 0; i < identities.length; i += 1) {
      for (let j = i + 1; j < identities.length; j += 1) {
        const left = identities[i];
        const right = identities[j];
        const leftContests = contestsByPair.get(`${left.organization}${PAIR_SEPARATOR}${left.name}`);
        const rightContests = contestsByPair.get(`${right.organization}${PAIR_SEPARATOR}${right.name}`);
        if (!leftContests || !rightContests) {
          continue;
        }
        const shared = [...rightContests].filter((key) => leftContests.has(key));
        if (shared.length > 0) {
          conflicts.push({
            canonical: `${canonical.organization} / ${canonical.name}`,
            left: `${left.organization} / ${left.name}`,
            right: `${right.organization} / ${right.name}`,
            sharedContests: shared.slice(0, 5),
            sharedContestCount: shared.length,
          });
        }
      }
    }
  }
  return conflicts;
}

module.exports = {
  PAIR_SEPARATOR,
  emptyAliases,
  loadAliases,
  resolveAlias,
  findMergeConflicts,
};
