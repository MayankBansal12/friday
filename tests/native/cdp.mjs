import assert from 'node:assert/strict';
export async function connectRenderer(port) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  assert(page, 'Friday renderer did not start');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    pending.get(response.id)?.(response);
  });
  async function call(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, 10_000);
      pending.set(requestId, (response) => {
        clearTimeout(timer);
        pending.delete(requestId);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  return { call, close: () => socket.close() };
}
