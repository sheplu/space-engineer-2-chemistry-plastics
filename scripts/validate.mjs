#!/usr/bin/env node
// Validator for Chemistry & Plastics mod datasets.
// Ports the Backpack Upgrades / Coal Power / Forestry pattern and extends it
// with **sibling-mod cross-reference**: this is the first mod in the workspace
// whose recipe ingredients reach into another mod's id namespace (Forestry's
// `resin`, Petroleum Power's `gasoline`). The base-game cross-ref behavior is
// unchanged; sibling-mod loading uses the same graceful "skip with warning"
// pattern when a repo is missing.
//
// Cross-reference scope:
//   1. JSON Schema validation (envelope, index, item).
//   2. Cross-reference: every `recipe.ingredients[].id` must resolve to a
//      base-game id, a local id, OR an id from a declared sibling mod.
//   3. Cross-reference: every `recipe.producedBy` display name must match a
//      base-game or local block displayName, or one of a small set of
//      well-known non-block producers (e.g. "Backpack Building").
//
// Env overrides (all optional, default to sibling directory lookup):
//   BASE_GAME_REPO     — path to space-engineer-2-base-game
//   FORESTRY_REPO      — path to space-engineer-2-forestry
//   PETROLEUM_REPO     — path to space-engineer-2-petroleum-power

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));
const loadAbs = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats.default(ajv);

const envelopeSchema = load("schemas/envelope.schema.json");
const indexSchema = load("schemas/index.schema.json");
const itemSchema = load("schemas/resource-item.schema.json");

const validateEnvelope = ajv.compile(envelopeSchema);
const validateIndex = ajv.compile(indexSchema);
const validateItem = ajv.compile(itemSchema);

const index = load("index.json");

// Cross-reference universes.
const baseRepoPath =
  process.env.BASE_GAME_REPO ??
  resolve(repoRoot, "..", "space-engineer-2-base-game");
const forestryRepoPath =
  process.env.FORESTRY_REPO ??
  resolve(repoRoot, "..", "space-engineer-2-forestry");
const petroleumRepoPath =
  process.env.PETROLEUM_REPO ??
  resolve(repoRoot, "..", "space-engineer-2-petroleum-power");

let baseLoaded = false;
const baseRawIds = new Set();
const baseItemIds = new Set();
const baseItemDisplayNames = new Set();
const baseBlockDisplayNames = new Set();

const baseRawPath = resolve(baseRepoPath, "data/raw-resources.json");
const baseBlocksDir = resolve(baseRepoPath, "data/blocks");

if (existsSync(baseRawPath)) {
  const baseRaw = loadAbs(baseRawPath);
  for (const r of baseRaw.resources) baseRawIds.add(r.id);

  const itemFiles = [
    "data/components/simple.json",
    "data/components/complex.json",
    "data/components/high-tech.json",
    "data/refinery-products.json",
    "data/character-gear.json",
    "data/ammunition.json",
  ];
  for (const rel of itemFiles) {
    const abs = resolve(baseRepoPath, rel);
    if (!existsSync(abs)) continue;
    const doc = loadAbs(abs);
    for (const r of doc.resources) {
      baseItemIds.add(r.id);
      if (r.displayName) baseItemDisplayNames.add(r.displayName);
    }
  }

  const walkBlocks = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walkBlocks(p);
      else if (name.endsWith(".json")) {
        const doc = loadAbs(p);
        for (const r of doc.resources ?? []) {
          if (r.displayName) baseBlockDisplayNames.add(r.displayName);
          // Power cells live under blocks/ but are item records.
          if (r.id) baseItemIds.add(r.id);
        }
      }
    }
  };
  walkBlocks(baseBlocksDir);

  baseLoaded = true;
  console.log(
    `✓ base-game cross-ref loaded: ${baseRawIds.size} raw ids, ${baseItemIds.size} item/block ids, ${baseBlockDisplayNames.size} block displayNames`,
  );
} else {
  console.warn(
    `! base-game repo not found at ${baseRepoPath} — skipping cross-reference checks (set BASE_GAME_REPO to enable)`,
  );
}

// Sibling-mod loading. Each sibling contributes raw ids, item ids, item
// displayNames, and block displayNames into the known-ids universe. Used by
// mods whose recipes reach into another mod's id namespace (first precedent:
// this mod's monomer recipes consuming `resin` and `gasoline`).
const siblingRawIds = new Set();
const siblingItemIds = new Set();
const siblingItemDisplayNames = new Set();
const siblingBlockDisplayNames = new Set();

const loadSiblingMod = (label, path) => {
  const indexPath = resolve(path, "index.json");
  if (!existsSync(indexPath)) {
    console.warn(
      `! ${label} mod not found at ${path} — skipping sibling-mod cross-reference (set the matching env var to enable)`,
    );
    return;
  }
  const siblingIndex = loadAbs(indexPath);
  for (const entry of siblingIndex.datasets ?? []) {
    const abs = resolve(path, entry.path);
    if (!existsSync(abs)) continue;
    const doc = loadAbs(abs);
    for (const r of doc.resources ?? []) {
      if (!r?.id) continue;
      if (entry.id === "raw-resources") {
        siblingRawIds.add(r.id);
      } else if (entry.id.startsWith("blocks-")) {
        if (r.displayName) siblingBlockDisplayNames.add(r.displayName);
      } else {
        siblingItemIds.add(r.id);
        if (r.displayName) siblingItemDisplayNames.add(r.displayName);
      }
    }
  }
  console.log(
    `✓ ${label} sibling-mod cross-ref loaded from ${indexPath}`,
  );
};

if (baseLoaded) {
  loadSiblingMod("Forestry", forestryRepoPath);
  loadSiblingMod("Petroleum Power", petroleumRepoPath);
}

// Well-known non-block producers used across vanilla.
const nonBlockProducers = new Set(["Backpack Building"]);

// Local ids tracked across this mod's datasets.
const localItemIds = new Set();
const localItemDisplayNames = new Set();
const localBlockDisplayNames = new Set();

let failures = 0;
const report = (label, errors) => {
  if (!errors || errors.length === 0) return;
  failures += errors.length;
  console.error(`✗ ${label}`);
  for (const err of errors) {
    console.error(`    ${err.instancePath || "(root)"} ${err.message}`);
    if (err.params && Object.keys(err.params).length) {
      console.error(`      params: ${JSON.stringify(err.params)}`);
    }
  }
};

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failures += 1;
};

const recordKindFor = (datasetId) => {
  if (datasetId === "items") return { kind: "item", fn: validateItem };
  throw new Error(`Unknown dataset id: ${datasetId}`);
};

if (!validateIndex(index)) {
  report("index.json", validateIndex.errors);
} else {
  console.log("✓ index.json");
}

// First pass: schema + envelope validation. Collect local ids.
const perDatasetRecords = new Map();
for (const entry of index.datasets) {
  const data = load(entry.path);
  const label = entry.path;

  if (!validateEnvelope(data)) {
    report(`${label} (envelope)`, validateEnvelope.errors);
    continue;
  }

  const { kind, fn } = recordKindFor(entry.id);
  let recordFailures = 0;
  for (const [i, rec] of data.resources.entries()) {
    const recLabel = `${label} [${i}] ${kind} record "${rec.id ?? "?"}"`;
    if (!fn(rec)) {
      recordFailures += fn.errors.length;
      report(recLabel, fn.errors);
    } else {
      if (kind === "item") {
        localItemIds.add(rec.id);
        if (rec.displayName) localItemDisplayNames.add(rec.displayName);
      }
    }
  }

  if (data.resources.length !== entry.entryCount) {
    fail(
      `${label} — index declares ${entry.entryCount} entries but file has ${data.resources.length}`,
    );
  }
  if (recordFailures === 0) {
    console.log(`✓ ${label} (${data.resources.length} ${kind} records)`);
  }
  perDatasetRecords.set(entry.id, data.resources);
}

// Second pass: cross-reference checks (only if base-game data is loaded).
if (baseLoaded) {
  const ids = new Set([
    ...baseRawIds,
    ...baseItemIds,
    ...siblingRawIds,
    ...siblingItemIds,
    ...localItemIds,
  ]);
  const itemDisplayNames = new Set([
    ...baseItemDisplayNames,
    ...siblingItemDisplayNames,
    ...localItemDisplayNames,
  ]);
  const isKnownProducer = (name) =>
    baseBlockDisplayNames.has(name) ||
    siblingBlockDisplayNames.has(name) ||
    localBlockDisplayNames.has(name) ||
    nonBlockProducers.has(name);

  // Items: check every recipe's ingredients[].id and producedBy.
  const itemRecs = perDatasetRecords.get("items") ?? [];
  for (const rec of itemRecs) {
    const label = `data/items.json record "${rec.id}"`;
    for (const [ri, recipe] of (rec.recipes ?? []).entries()) {
      if (!isKnownProducer(recipe.producedBy)) {
        fail(
          `${label} — recipe[${ri}] producedBy "${recipe.producedBy}" does not match any base-game, sibling-mod, or local block displayName (nor a known non-block producer)`,
        );
      }
      for (const [ii, ing] of recipe.ingredients.entries()) {
        if (!ids.has(ing.id)) {
          fail(
            `${label} — recipe[${ri}].ingredients[${ii}].id "${ing.id}" is not a base-game, sibling-mod, or local raw/item id`,
          );
        }
      }
    }
  }

  // totalEntries sanity.
  const sumEntries = index.datasets.reduce((a, d) => a + d.entryCount, 0);
  if (index.totalEntries !== sumEntries) {
    fail(
      `index.json — totalEntries declares ${index.totalEntries} but dataset entryCount sum is ${sumEntries}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation error(s)`);
  process.exit(1);
}
console.log("\nAll datasets valid.");
