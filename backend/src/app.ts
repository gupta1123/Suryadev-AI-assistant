import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { errorHandler } from './lib/http.js';
import { authRouter } from './modules/auth/routes.js';
import { invoiceDeliveryRouter } from './modules/invoice-delivery/routes.js';
import { msg91WebhookRouter } from './modules/invoice-delivery/webhook.js';
import { healthRouter } from './routes/health.js';

export const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(
  cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(
  pinoHttp({
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-msg91-webhook-secret"]',
        'res.headers.set-cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
  }),
);

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/invoice-delivery', invoiceDeliveryRouter);
app.use('/api/webhooks/msg91', msg91WebhookRouter);

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.use(errorHandler);
