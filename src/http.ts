import express from 'express';
import { getRequestListener } from '@hono/node-server';
import { createApp, type CreateAppOptions } from './app.js';
import { installMcpOAuth } from '../oauth/service.mjs';

export function createHttpApp(options: CreateAppOptions & { ownerKey?: string; origin?: string; oauthStore?: unknown } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const auth = installMcpOAuth(app, {
    name: 'dokploy', origin: options.origin || process.env.PUBLIC_ORIGIN || 'https://dokploy-manager.etdofresh.com',
    ownerKey: options.ownerKey ?? process.env.MCP_OWNER_KEY, scope: 'dokploy.manage',
    description: 'Read Dokploy services, configuration and logs, and perform the deployment and configuration changes you request.',
    ...(options.oauthStore ? { store: options.oauthStore } : {}),
  });
  const service = createApp({ ...options, mcpAuth: auth });
  app.use(getRequestListener(service.fetch));
  return app;
}
