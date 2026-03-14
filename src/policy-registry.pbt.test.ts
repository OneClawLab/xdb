import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { PolicyRegistry, PolicyConfig, FieldConfig } from './policy-registry.js';
import { XDBError } from './errors.js';

const registry = new PolicyRegistry();

// --- Generators ---

/** Arbitrary main engine type */
const arbMainType = fc.constantFrom<'hybrid' | 'relational' | 'vector'>('hybrid', 'relational', 'vector');

/** Default minors per main type */
const DEFAULT_MINORS: Record<string, string> = {
  hybrid: 'knowledge-base',
  relational: 'structured-logs',
  vector: 'feature-store',
};

/** Arbitrary field name (simple alphanumeric) */
const arbFieldName = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

/** Arbitrary findCaps array constrained to valid values */
const arbFindCaps = fc.subarray<'similar' | 'match'>(['similar', 'match'], { minLength: 0, maxLength: 2 });

/** Arbitrary FieldConfig */
const arbFieldConfig: fc.Arbitrary<FieldConfig> = arbFindCaps.map((caps) => ({ findCaps: caps }));

/** Arbitrary fields record (0-5 fields) */
const arbFields: fc.Arbitrary<Record<string, FieldConfig>> = fc
  .array(fc.tuple(arbFieldName, arbFieldConfig), { minLength: 0, maxLength: 5 })
  .map((entries) => Object.fromEntries(entries));

/** Arbitrary PolicyConfig with any findCaps (may be invalid) */
const arbPolicyConfig: fc.Arbitrary<PolicyConfig> = fc.record({
  main: arbMainType,
  minor: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
  fields: arbFields,
  autoIndex: fc.boolean(),
});

/**
 * Generate a valid PolicyConfig where findCaps are compatible with the main type.
 */
const arbValidPolicyConfig: fc.Arbitrary<PolicyConfig> = arbMainType.chain((main) => {
  const allowedCaps: Array<'similar' | 'match'> =
    main === 'hybrid' ? ['similar', 'match'] :
    main === 'relational' ? ['match'] :
    ['similar'];

  const validFieldConfig: fc.Arbitrary<FieldConfig> = fc
    .subarray(allowedCaps, { minLength: 0, maxLength: allowedCaps.length })
    .map((caps) => ({ findCaps: caps }));

  const validFields: fc.Arbitrary<Record<string, FieldConfig>> = fc
    .array(fc.tuple(arbFieldName, validFieldConfig), { minLength: 0, maxLength: 5 })
    .map((entries) => Object.fromEntries(entries));

  return fc.record({
    main: fc.constant(main),
    minor: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
    fields: validFields,
    autoIndex: fc.boolean(),
  });
});

/**
 * Helper: determine engine combination from a PolicyConfig.
 * Based on design: hybrid → both, relational → sqlite only, vector → lance only.
 */
function engineCombination(config: PolicyConfig): { lance: boolean; sqlite: boolean } {
  switch (config.main) {
    case 'hybrid':
      return { lance: true, sqlite: true };
    case 'relational':
      return { lance: false, sqlite: true };
    case 'vector':
      return { lance: true, sqlite: false };
  }
}

// --- Property Tests ---

describe('PolicyRegistry Property-Based Tests', () => {
  // Feature: xdb-core, Property 1: Policy 解析正确性
  // **Validates: Requirements 9.2**
  describe('Property 1: Policy 解析正确性', () => {
    it('resolving main-only should equal resolving main/default-minor', () => {
      fc.assert(
        fc.property(arbMainType, (main) => {
          const fromMainOnly = registry.resolve(main);
          const fromFullName = registry.resolve(`${main}/${DEFAULT_MINORS[main]}`);

          expect(fromMainOnly.main).toBe(fromFullName.main);
          expect(fromMainOnly.minor).toBe(fromFullName.minor);
          expect(fromMainOnly.fields).toEqual(fromFullName.fields);
          expect(fromMainOnly.autoIndex).toBe(fromFullName.autoIndex);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 2: findCaps 与引擎类型一致性
  // **Validates: Requirements 9.11, 6.5, 7.4**
  describe('Property 2: findCaps 与引擎类型一致性', () => {
    it('relational configs with "similar" findCaps should be rejected by validate', () => {
      // Generate relational configs that have at least one field with 'similar'
      const arbRelationalWithSimilar: fc.Arbitrary<PolicyConfig> = fc
        .tuple(
          arbFieldName,
          fc.subarray<'similar' | 'match'>(['similar', 'match'], { minLength: 1, maxLength: 2 }).filter((caps) =>
            caps.includes('similar'),
          ),
          arbFields,
        )
        .map(([badFieldName, badCaps, otherFields]) => ({
          main: 'relational' as const,
          minor: 'test',
          fields: { ...otherFields, [badFieldName]: { findCaps: badCaps } },
          autoIndex: true,
        }));

      fc.assert(
        fc.property(arbRelationalWithSimilar, (config) => {
          expect(() => registry.validate(config)).toThrow(XDBError);
        }),
        { numRuns: 100 },
      );
    });

    it('vector configs with "match" findCaps should be rejected by validate', () => {
      // Generate vector configs that have at least one field with 'match'
      const arbVectorWithMatch: fc.Arbitrary<PolicyConfig> = fc
        .tuple(
          arbFieldName,
          fc.subarray<'similar' | 'match'>(['similar', 'match'], { minLength: 1, maxLength: 2 }).filter((caps) =>
            caps.includes('match'),
          ),
          arbFields,
        )
        .map(([badFieldName, badCaps, otherFields]) => ({
          main: 'vector' as const,
          minor: 'test',
          fields: { ...otherFields, [badFieldName]: { findCaps: badCaps } },
          autoIndex: true,
        }));

      fc.assert(
        fc.property(arbVectorWithMatch, (config) => {
          expect(() => registry.validate(config)).toThrow(XDBError);
        }),
        { numRuns: 100 },
      );
    });

    it('valid configs (findCaps compatible with main) should pass validate', () => {
      fc.assert(
        fc.property(arbValidPolicyConfig, (config) => {
          expect(() => registry.validate(config)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 3: main 类型决定引擎组合
  // **Validates: Requirements 9.6, 9.7, 9.8**
  describe('Property 3: main 类型决定引擎组合', () => {
    it('engine combination is determined solely by main type', () => {
      fc.assert(
        fc.property(arbValidPolicyConfig, (config) => {
          const engines = engineCombination(config);

          switch (config.main) {
            case 'hybrid':
              expect(engines).toEqual({ lance: true, sqlite: true });
              break;
            case 'relational':
              expect(engines).toEqual({ lance: false, sqlite: true });
              break;
            case 'vector':
              expect(engines).toEqual({ lance: true, sqlite: false });
              break;
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
