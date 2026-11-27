// Open SSE streams. Each entry records the API token that opened it (null for
// session callers), so revoking a token can end its streams (#9).
const clients = new Map();

function addClient(res, { tokenId = null } = {}) {
  clients.set(res, { tokenId });
  res.on('close', () => clients.delete(res));
}

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients.keys()) {
    client.write(message);
  }
}

function getClientCount() {
  return clients.size;
}

function countClientsForToken(tokenId) {
  let count = 0;
  for (const meta of clients.values()) {
    if (meta.tokenId === tokenId) count++;
  }
  return count;
}

/** End every open stream opened with this token. Returns how many were closed. */
function closeClientsForToken(tokenId) {
  let closed = 0;
  for (const [res, meta] of clients) {
    if (meta.tokenId === tokenId) {
      clients.delete(res);
      res.end();
      closed++;
    }
  }
  return closed;
}

module.exports = { addClient, broadcast, getClientCount, countClientsForToken, closeClientsForToken };
