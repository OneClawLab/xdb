import { PARAMETER_ERROR, XDBError } from './errors.js';

export interface FieldConfig {
  findCaps: Array<'similar' | 'match'>;
}

export interface PolicyConfig {
  main: 'hybrid' | 'relational' | 'vector';
  minor: string;
  fields: Record<string, FieldConfig>;
  autoIndex?: boolean;
}

const BUILTIN_POLICIES: Record<string, PolicyConfig> = {
  'hybrid/knowledge-base': {
    main: 'hybrid',
    minor: 'knowledge-base',
    fields: { content: { findCaps: ['similar', 'match'] } },
    autoIndex: true,
  },
  'relational/structured-logs': {
    main: 'relational',
    minor: 'structured-logs',
    fields: {},
    autoIndex: true,
  },
  'relational/simple-kv': {
    main: 'relational',
    minor: 'simple-kv',
    fields: {},
    autoIndex: false,
  },
  'vector/feature-store': {
    main: 'vector',
    minor: 'feature-store',
    fields: { tensor: { findCaps: ['similar'] } },
    autoIndex: false,
  },
};

const DEFAULT_MINORS: Record<string, string> = {
  hybrid: 'knowledge-base',
  relational: 'structured-logs',
  vector: 'feature-store',
};

/** Allowed findCaps per main engine type */
const ALLOWED_CAPS: Record<string, Set<string>> = {
  hybrid: new Set(['similar', 'match']),
  relational: new Set(['match']),
  vector: new Set(['similar']),
};

export class PolicyRegistry {
  /**
   * Resolve a policy string like "hybrid/knowledge-base" or just "hybrid"
   * into a full PolicyConfig. Optionally deep-merge params overrides.
   */
  resolve(policyStr: string, params?: Record<string, unknown>): PolicyConfig {
    let fullName = policyStr;

    // If no slash, resolve using default minor
    if (!policyStr.includes('/')) {
      const defaultMinor = DEFAULT_MINORS[policyStr];
      if (!defaultMinor) {
        const available = Object.keys(BUILTIN_POLICIES).join(', ');
        throw new XDBError(PARAMETER_ERROR, `Unknown policy "${policyStr}". Available policies: ${available}`);
      }
      fullName = `${policyStr}/${defaultMinor}`;
    }

    const builtin = BUILTIN_POLICIES[fullName];
    if (!builtin) {
      const available = Object.keys(BUILTIN_POLICIES).join(', ');
      throw new XDBError(PARAMETER_ERROR, `Unknown policy "${fullName}". Available policies: ${available}`);
    }

    // Deep clone the builtin policy
    const config: PolicyConfig = {
      main: builtin.main,
      minor: builtin.minor,
      fields: deepCloneFields(builtin.fields),
      autoIndex: builtin.autoIndex,
    };

    // Merge params overrides (especially fields)
    if (params) {
      if (params.fields && typeof params.fields === 'object') {
        const paramFields = params.fields as Record<string, FieldConfig>;
        for (const [fieldName, fieldConfig] of Object.entries(paramFields)) {
          config.fields[fieldName] = { findCaps: [...fieldConfig.findCaps] };
        }
      }
      if (params.autoIndex !== undefined) {
        config.autoIndex = params.autoIndex as boolean;
      }
    }

    return config;
  }

  /**
   * Validate that a PolicyConfig's findCaps are compatible with its main engine type.
   * Throws XDBError(PARAMETER_ERROR) if validation fails.
   */
  validate(config: PolicyConfig): void {
    const allowed = ALLOWED_CAPS[config.main];
    if (!allowed) {
      throw new XDBError(PARAMETER_ERROR, `Unknown main engine type "${config.main}"`);
    }

    for (const [fieldName, fieldConfig] of Object.entries(config.fields)) {
      for (const cap of fieldConfig.findCaps) {
        if (!allowed.has(cap)) {
          throw new XDBError(
            PARAMETER_ERROR,
            `findCaps "${cap}" is not compatible with engine type "${config.main}" (field: "${fieldName}")`,
          );
        }
      }
    }
  }

  /** List all available built-in policies. */
  listPolicies(): PolicyConfig[] {
    return Object.values(BUILTIN_POLICIES).map((p) => ({
      main: p.main,
      minor: p.minor,
      fields: deepCloneFields(p.fields),
      autoIndex: p.autoIndex,
    }));
  }
}

function deepCloneFields(fields: Record<string, FieldConfig>): Record<string, FieldConfig> {
  const result: Record<string, FieldConfig> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = { findCaps: [...value.findCaps] };
  }
  return result;
}
