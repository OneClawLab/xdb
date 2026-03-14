import { describe, it, expect } from 'vitest';
import { PolicyRegistry } from './policy-registry.js';
import { XDBError, PARAMETER_ERROR } from './errors.js';

describe('PolicyRegistry', () => {
  const registry = new PolicyRegistry();

  describe('resolve', () => {
    it('resolves full "main/minor" policy name', () => {
      const config = registry.resolve('hybrid/knowledge-base');
      expect(config.main).toBe('hybrid');
      expect(config.minor).toBe('knowledge-base');
      expect(config.fields.content.findCaps).toEqual(['similar', 'match']);
      expect(config.autoIndex).toBe(true);
    });

    it('resolves "hybrid" to "hybrid/knowledge-base" by default', () => {
      const config = registry.resolve('hybrid');
      expect(config.main).toBe('hybrid');
      expect(config.minor).toBe('knowledge-base');
    });

    it('resolves "relational" to "relational/structured-logs" by default', () => {
      const config = registry.resolve('relational');
      expect(config.main).toBe('relational');
      expect(config.minor).toBe('structured-logs');
    });

    it('resolves "vector" to "vector/feature-store" by default', () => {
      const config = registry.resolve('vector');
      expect(config.main).toBe('vector');
      expect(config.minor).toBe('feature-store');
      expect(config.fields.tensor.findCaps).toEqual(['similar']);
    });

    it('resolves relational/simple-kv with autoIndex false', () => {
      const config = registry.resolve('relational/simple-kv');
      expect(config.main).toBe('relational');
      expect(config.minor).toBe('simple-kv');
      expect(config.fields).toEqual({});
      expect(config.autoIndex).toBe(false);
    });

    it('throws PARAMETER_ERROR for unknown main type', () => {
      expect(() => registry.resolve('unknown')).toThrow(XDBError);
      try {
        registry.resolve('unknown');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
        expect((e as XDBError).message).toContain('Unknown policy');
        expect((e as XDBError).message).toContain('Available policies');
      }
    });

    it('throws PARAMETER_ERROR for unknown full policy name', () => {
      expect(() => registry.resolve('hybrid/nonexistent')).toThrow(XDBError);
      try {
        registry.resolve('hybrid/nonexistent');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
      }
    });

    it('deep merges params fields into resolved policy', () => {
      const config = registry.resolve('hybrid/knowledge-base', {
        fields: { summary: { findCaps: ['match'] } },
      });
      expect(config.fields.content.findCaps).toEqual(['similar', 'match']);
      expect(config.fields.summary.findCaps).toEqual(['match']);
    });

    it('params can override existing field findCaps', () => {
      const config = registry.resolve('hybrid/knowledge-base', {
        fields: { content: { findCaps: ['similar'] } },
      });
      expect(config.fields.content.findCaps).toEqual(['similar']);
    });

    it('params can override autoIndex', () => {
      const config = registry.resolve('hybrid/knowledge-base', {
        autoIndex: false,
      });
      expect(config.autoIndex).toBe(false);
    });

    it('returns a deep clone — mutations do not affect builtin', () => {
      const config1 = registry.resolve('hybrid/knowledge-base');
      config1.fields.content.findCaps.push('match');
      config1.fields.newField = { findCaps: ['similar'] };

      const config2 = registry.resolve('hybrid/knowledge-base');
      expect(config2.fields.content.findCaps).toEqual(['similar', 'match']);
      expect(config2.fields.newField).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('accepts valid hybrid config with similar and match', () => {
      const config = registry.resolve('hybrid/knowledge-base');
      expect(() => registry.validate(config)).not.toThrow();
    });

    it('accepts valid relational config with no findCaps', () => {
      const config = registry.resolve('relational/structured-logs');
      expect(() => registry.validate(config)).not.toThrow();
    });

    it('accepts valid vector config with similar only', () => {
      const config = registry.resolve('vector/feature-store');
      expect(() => registry.validate(config)).not.toThrow();
    });

    it('rejects relational config with "similar" findCaps', () => {
      const config = registry.resolve('relational/structured-logs', {
        fields: { embedding: { findCaps: ['similar'] } },
      });
      expect(() => registry.validate(config)).toThrow(XDBError);
      try {
        registry.validate(config);
      } catch (e) {
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
        expect((e as XDBError).message).toContain('similar');
        expect((e as XDBError).message).toContain('relational');
      }
    });

    it('rejects vector config with "match" findCaps', () => {
      const config = registry.resolve('vector/feature-store', {
        fields: { text: { findCaps: ['match'] } },
      });
      expect(() => registry.validate(config)).toThrow(XDBError);
      try {
        registry.validate(config);
      } catch (e) {
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
        expect((e as XDBError).message).toContain('match');
        expect((e as XDBError).message).toContain('vector');
      }
    });

    it('accepts relational config with "match" findCaps', () => {
      const config = registry.resolve('relational/structured-logs', {
        fields: { body: { findCaps: ['match'] } },
      });
      expect(() => registry.validate(config)).not.toThrow();
    });

    it('accepts hybrid config with mixed findCaps across fields', () => {
      const config = registry.resolve('hybrid/knowledge-base', {
        fields: {
          content: { findCaps: ['similar', 'match'] },
          title: { findCaps: ['match'] },
          embedding: { findCaps: ['similar'] },
        },
      });
      expect(() => registry.validate(config)).not.toThrow();
    });
  });

  describe('listPolicies', () => {
    it('returns all 4 built-in policies', () => {
      const policies = registry.listPolicies();
      expect(policies).toHaveLength(4);
    });

    it('includes all expected main types', () => {
      const policies = registry.listPolicies();
      const mains = policies.map((p) => p.main);
      expect(mains).toContain('hybrid');
      expect(mains).toContain('relational');
      expect(mains).toContain('vector');
    });

    it('includes all expected minor names', () => {
      const policies = registry.listPolicies();
      const names = policies.map((p) => `${p.main}/${p.minor}`);
      expect(names).toContain('hybrid/knowledge-base');
      expect(names).toContain('relational/structured-logs');
      expect(names).toContain('relational/simple-kv');
      expect(names).toContain('vector/feature-store');
    });

    it('returns deep clones — mutations do not affect registry', () => {
      const policies = registry.listPolicies();
      const hybrid = policies.find((p) => p.main === 'hybrid')!;
      hybrid.fields.content.findCaps = [];

      const policiesAgain = registry.listPolicies();
      const hybridAgain = policiesAgain.find((p) => p.main === 'hybrid')!;
      expect(hybridAgain.fields.content.findCaps).toEqual(['similar', 'match']);
    });
  });
});
