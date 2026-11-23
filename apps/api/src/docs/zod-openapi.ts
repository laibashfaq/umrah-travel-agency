import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

type JsonSchema = Record<string, unknown>;

const toSchema = (schema: ZodType): JsonSchema => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;

/** Documents a request body from the same zod schema that validates it, so docs cannot drift from behaviour. */
export const ApiZodBody = (schema: ZodType) => ApiBody({ schema: toSchema(schema) as never });

/** Documents each property of a zod object as a query parameter. */
export function ApiZodQuery(schema: ZodType) {
  const json = toSchema(schema);
  const props = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required ?? []) as string[]);
  return applyDecorators(...Object.entries(props).map(([name, s]) => ApiQuery({ name, required: required.has(name), schema: s as never })));
}
