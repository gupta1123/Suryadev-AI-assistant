import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/http.js';
import { requireAdmin } from '../../middleware/auth.js';
import { getCustomer, listCustomers } from './repository.js';

const customerIdSchema = z.coerce.number().int().positive();

export const customersRouter = Router();

customersRouter.use((request, response, next) => {
  void requireAdmin(request, response, next);
});

customersRouter.get(
  '/',
  asyncHandler(async (_request, response) => {
    response.json({ data: await listCustomers() });
  }),
);

customersRouter.get(
  '/:customerId',
  asyncHandler(async (request, response) => {
    response.json({ data: await getCustomer(customerIdSchema.parse(request.params.customerId)) });
  }),
);
