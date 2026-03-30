import type { z } from 'zod';
import type { ResolvedEnv, Capabilities } from '../env.js';

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: TSchema;
  capability?: keyof Capabilities;
  handler: (params: z.infer<TSchema>, env: ResolvedEnv) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Convert Zod schema to MCP-compatible JSON Schema.
 */
export function zodToInputSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    properties[key] = zodTypeToJsonSchema(zodType);
    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function zodTypeToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
  const desc = zodType.description;
  const base: Record<string, unknown> = {};
  if (desc) base.description = desc;

  // Unwrap optional/default
  if (zodType._def.typeName === 'ZodOptional') {
    return zodTypeToJsonSchema(zodType._def.innerType);
  }
  if (zodType._def.typeName === 'ZodDefault') {
    const inner = zodTypeToJsonSchema(zodType._def.innerType);
    inner.default = zodType._def.defaultValue();
    if (desc) inner.description = desc;
    return inner;
  }

  // Primitives
  if (zodType._def.typeName === 'ZodString') {
    return { ...base, type: 'string' };
  }
  if (zodType._def.typeName === 'ZodNumber') {
    const schema: Record<string, unknown> = { ...base, type: 'number' };
    for (const check of zodType._def.checks || []) {
      if (check.kind === 'min') schema.minimum = check.value;
      if (check.kind === 'max') schema.maximum = check.value;
      if (check.kind === 'int') schema.type = 'integer';
    }
    return schema;
  }
  if (zodType._def.typeName === 'ZodBoolean') {
    return { ...base, type: 'boolean' };
  }

  // Array
  if (zodType._def.typeName === 'ZodArray') {
    const schema: Record<string, unknown> = { ...base, type: 'array', items: zodTypeToJsonSchema(zodType._def.type) };
    if (zodType._def.minLength) schema.minItems = zodType._def.minLength.value;
    if (zodType._def.maxLength) schema.maxItems = zodType._def.maxLength.value;
    return schema;
  }

  // Enum
  if (zodType._def.typeName === 'ZodEnum') {
    return { ...base, type: 'string', enum: zodType._def.values };
  }

  // Object
  if (zodType._def.typeName === 'ZodObject') {
    return { ...base, ...zodToInputSchema(zodType as any) };
  }

  return { ...base, type: 'string' };
}
