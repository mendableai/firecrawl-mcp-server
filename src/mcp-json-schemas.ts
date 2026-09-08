import { z } from 'zod';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Arbitrary JSON object for MCP tool parameters.
 *
 * Avoid z.record(): fastmcp's strictJsonSchema turns it into an unsatisfiable
 * object schema (propertyNames + additionalProperties: false, no properties).
 */
export const mcpJsonObject = z.json().refine(isJsonObject, {
  message: 'Expected a JSON object',
});

export const mcpJsonObjectOptional = mcpJsonObject.optional();

/** JSON object whose values are all strings (e.g. webhook header maps). */
export const mcpStringMapOptional = z
  .json()
  .refine(
    (value) =>
      isJsonObject(value) &&
      Object.values(value).every((entry) => typeof entry === 'string'),
    { message: 'Expected an object with string values' }
  )
  .optional();

/** JSON Schema document for scrape/agent jsonOptions.schema. */
export const mcpJsonSchemaDocumentOptional = mcpJsonObjectOptional;
