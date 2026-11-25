#!/usr/bin/env node
// Mint a read-only API token from the host (#9), for headless clients such as
// the WLED agent or Auden. Prints the token once; only its hash is stored.
//
//   node src/cli/create-api-token.js <name>
//
// Uses the same DB_PATH as the server. In Docker:
//   docker compose exec gitactionsview node src/cli/create-api-token.js auden

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('Usage: node src/cli/create-api-token.js <name>');
  process.exit(1);
}

const { createToken } = require('../services/apiTokens');
const { closeDb } = require('../db/database');

try {
  const created = createToken(name, 'cli');
  console.log(`Created token ${created.id} "${created.name}". It will not be shown again:`);
  console.log(created.token);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  closeDb();
}
