import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const messages = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        res.status(400).json({ error: 'Validation failed', details: messages });
      } else {
        next(err);
      }
    }
  };
}
