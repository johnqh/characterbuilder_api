import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { errorResponse } from '@sudobility/characterbuilder_types';

type Target = 'json' | 'query' | 'param';

/** Zod validator that renders failures as the standard VALIDATION envelope. */
export function validate<T extends ZodType>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        errorResponse('Invalid request', 'VALIDATION', {
          issues: result.error.issues,
        }),
        400
      );
    }
  });
}
