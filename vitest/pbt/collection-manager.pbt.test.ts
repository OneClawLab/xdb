import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionManager } from '../../src/collection-manager.js';
import type { CollectionMeta } from '../../src/collection-manager.js';
import { PolicyRegistry } from '../../src/policy-registry.js';
import type { PolicyConfig, FieldConfig } from '../../src/policy-registry.js';

const registry = new PolicyRegistry();

// --- Generators ---

/** Arbitrary simple alphanumeric collection name (lowercase, 1-20 chars) */
const arbCollectionName = fc.stringMatching(/^[a-z][a-z0-9]{0,19}$/).filter((s) => s.length >= 1);

/** Arbitrary main engine type */
const arbMainType = fc.constantFrom<'hybrid' | 'relational' | 'vector'>('hybrid', 'relational', 'vector');

/** Built-in policy full names */
const BUILTIN_POLICY_NAMES = [
  'hybrid/knowledge-base',
  'relational/structured-logs',
  'relational/simple-kv',
  'vector/feature-store',
];

/** Arbitrary built-in policy name */
const arbBuiltinPolicyName = fc.constantFrom(...BUILTIN_POLICY_NAMES);

/** Arbitrary resolved built-in PolicyConfig */
const arbBuiltinPolicy: fc.Arbitrary<PolicyConfig> = arbBuiltinPolicyName.map((name) => registry.resolve(name));

/** Arbitrary field name */
const arbFieldName = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

/**
 * Generate a valid params override for a given built-in policy.
 * The override fields must have findCaps compatible with the policy's main type.
 */
function arbParamsForPolicy(policyName: string): fc.Arbitrary<Record<string, unknown>> {
  const policy = registry.resolve(policyName);
  const allowedCaps: Array<'similar' | 'match'> =
    policy.main === 'hybrid' ? ['similar', 'match'] :
    policy.main === 'relational' ? ['match'] :
    ['similar'];

  const validFieldConfig: fc.Arbitrary<FieldConfig> = fc
    .subarray(allowedCaps, { minLength: 0, maxLength: allowedCaps.length })
    .map((caps) => ({ findCaps: caps }));

  const validFields: fc.Arbitrary<Record<string, FieldConfig>> = fc
    .array(fc.tuple(arbFieldName, validFieldConfig), { minLength: 1, maxLength: 3 })
    .map((entries) => Object.fromEntries(entries));

  return fc.oneof(
    // Override fields only
    validFields.map((fields) => ({ fields })),
    // Override autoIndex only
    fc.boolean().map((autoIndex) => ({ autoIndex })),
    // Override both
    fc.tuple(validFields, fc.boolean()).map(([fields, autoIndex]) => ({ fields, autoIndex })),
  );
}

/** Arbitrary params override paired with a built-in policy name */
const arbPolicyWithParams: fc.Arbitrary<{ policyName: string; params: Record<string, unknown> }> =
  arbBuiltinPolicyName.chain((policyName) =>
    arbParamsForPolicy(policyName).map((params) => ({ policyName, params })),
  );

/** Arbitrary array of 0-5 unique collection names */
const arbUniqueCollectionNames: fc.Arbitrary<string[]> = fc
  .array(arbCollectionName, { minLength: 0, maxLength: 5 })
  .map((names) => [...new Set(names)]);

/** Arbitrary valid CollectionMeta */
const arbCollectionMeta: fc.Arbitrary<CollectionMeta> = fc.tuple(
  arbCollectionName,
  arbBuiltinPolicy,
  fc.integer({ min: 1577836800000, max: 1893456000000 }), // 2020-01-01 to 2030-01-01 in ms
).map(([name, policy, timestamp]) => ({
  name,
  policy,
  createdAt: new Date(timestamp).toISOString(),
}));

// --- Property Tests ---

describe('CollectionManager Property-Based Tests', () => {
  let tmpDir: string;
  let manager: CollectionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-pbt-cm-'));
    manager = new CollectionManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Feature: xdb-core, Property 4: params 覆盖后 Policy 快照正确性
  // **Validates: Requirements 1.2, 9.9, 9.10**
  describe('Property 4: params 覆盖后 Policy 快照正确性', () => {
    it('merged PolicyConfig contains override values and round-trips through collection_meta.json', async () => {
      await fc.assert(
        fc.asyncProperty(arbPolicyWithParams, async ({ policyName, params }) => {
          // Resolve with params override
          const merged = registry.resolve(policyName, params);

          // Verify override values are present in merged config
          if (params.fields && typeof params.fields === 'object') {
            const overrideFields = params.fields as Record<string, FieldConfig>;
            for (const [fieldName, fieldConfig] of Object.entries(overrideFields)) {
              expect(merged.fields[fieldName]).toBeDefined();
              expect(merged.fields[fieldName]!.findCaps).toEqual(fieldConfig.findCaps);
            }
          }
          if (params.autoIndex !== undefined) {
            expect(merged.autoIndex).toBe(params.autoIndex);
          }

          // Write to collection_meta.json via init, then read back via load
          const colName = `prop4col${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
          await manager.init(colName, merged);
          const loaded = await manager.load(colName);

          // Round-trip: loaded policy should be equivalent to merged
          expect(loaded.policy.main).toBe(merged.main);
          expect(loaded.policy.minor).toBe(merged.minor);
          expect(loaded.policy.fields).toEqual(merged.fields);
          expect(loaded.policy.autoIndex).toBe(merged.autoIndex);

          // Cleanup
          await manager.remove(colName);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 5: 集合 init-then-rm round-trip
  // **Validates: Requirements 1.1, 3.1, 11.4**
  describe('Property 5: 集合 init-then-rm round-trip', () => {
    it('after init directory exists, after rm directory does not exist', async () => {
      await fc.assert(
        fc.asyncProperty(arbCollectionName, arbBuiltinPolicy, async (name, policy) => {
          // Init: collection directory should exist
          await manager.init(name, policy);

          const colPath = join(tmpDir, 'collections', name);
          const metaPath = join(colPath, 'collection_meta.json');

          const dirStat = await stat(colPath);
          expect(dirStat.isDirectory()).toBe(true);

          // Verify collection_meta.json exists
          const metaStat = await stat(metaPath);
          expect(metaStat.isFile()).toBe(true);

          expect(await manager.exists(name)).toBe(true);

          // Remove: collection directory should not exist
          await manager.remove(name);

          expect(await manager.exists(name)).toBe(false);

          // Directory should be gone
          try {
            await stat(colPath);
            expect.fail('Directory should not exist after rm');
          } catch (err: unknown) {
            expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 6: col list 返回所有已创建集合
  // **Validates: Requirements 2.1, 2.2**
  describe('Property 6: col list 返回所有已创建集合', () => {
    it('list returns exactly the set of created collection names', async () => {
      await fc.assert(
        fc.asyncProperty(arbUniqueCollectionNames, arbBuiltinPolicy, async (names, policy) => {
          // Use a fresh manager per iteration to avoid cross-contamination
          const iterDir = await mkdtemp(join(tmpdir(), 'xdb-pbt-list-'));
          const iterManager = new CollectionManager(iterDir);

          try {
            // Create all collections
            for (const name of names) {
              await iterManager.init(name, policy);
            }

            // List and compare
            const listed = await iterManager.list();
            const listedNames = new Set(listed.map((c) => c.name));
            const expectedNames = new Set(names);

            expect(listedNames).toEqual(expectedNames);
          } finally {
            await rm(iterDir, { recursive: true, force: true });
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 14: CollectionMeta 序列化 round-trip
  // **Validates: Requirements 1.1, 9.10**
  describe('Property 14: CollectionMeta 序列化 round-trip', () => {
    it('serializing to JSON and deserializing yields equivalent object', async () => {
      await fc.assert(
        fc.asyncProperty(arbCollectionMeta, async (meta) => {
          // Serialize
          const json = JSON.stringify(meta, null, 2);

          // Write to a temp file and read back
          const filePath = join(tmpDir, `meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
          await writeFile(filePath, json, 'utf-8');
          const raw = await readFile(filePath, 'utf-8');
          const deserialized = JSON.parse(raw) as CollectionMeta;

          // Verify equivalence
          expect(deserialized.name).toBe(meta.name);
          expect(deserialized.createdAt).toBe(meta.createdAt);
          expect(deserialized.policy.main).toBe(meta.policy.main);
          expect(deserialized.policy.minor).toBe(meta.policy.minor);
          expect(deserialized.policy.fields).toEqual(meta.policy.fields);
          expect(deserialized.policy.autoIndex).toBe(meta.policy.autoIndex);
        }),
        { numRuns: 100 },
      );
    });
  });
});
