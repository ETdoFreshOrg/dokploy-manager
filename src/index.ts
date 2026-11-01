import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHttpApp } from './http.js';
import { OAuthStore } from '../oauth/oauth-store.mjs';

const port = parseInt(process.env.PORT || "3000", 10);
const dbPath = process.env.OAUTH_DB || '/data/oauth.db';
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new OAuthStore(dbPath);
const app = createHttpApp({ oauthStore: store });

console.log(`Dokploy Manager starting on port ${port}`);
const server = app.listen(port, '0.0.0.0');
process.once('SIGTERM', () => server.close(() => { store.close(); process.exit(0); }));
