/** Starts the API:  npm run server   (PORT, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, ALLOWED_ORIGIN) */
import { createServer } from 'node:http';
import { connect, migrate } from './db/connect.mjs';
import { createApp } from './app.mjs';

const db = connect();
await migrate(db);
const port = Number(process.env.PORT) || 8787;
createServer(createApp({ db })).listen(port, () => console.log(`Chimney Planner API on http://localhost:${port}`));
