// Local stand-in for Home Assistant's ingress proxy, for testing the add-on without
// Home Assistant:  node dev/ha-ingress-sim.js   then open http://127.0.0.1:8123
// It frames the add-on under a generated-looking path, strips that prefix, and adds the
// X-Remote-User-* headers, like the Supervisor does.
import http from 'node:http';

const PREFIX = '/api/hassio_ingress/TESTTOKEN123';
const TARGET = { host: '127.0.0.1', port: Number(process.env.ADDON_PORT || 8099) };

http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><title>HA stand-in</title><body style="margin:0;display:flex;height:100vh;font-family:sans-serif">
      <div style="width:56px;background:#1c1c1c"></div>
      <iframe src="${PREFIX}/" style="flex:1;border:0"></iframe></body>`);
  }
  if (!req.url.startsWith(`${PREFIX}/`)) { res.writeHead(404); return res.end('not found'); }
  const headers = { ...req.headers,
    'x-ingress-path': PREFIX, 'x-remote-user-id': 'abc123', 'x-remote-user-name': 'testuser', 'x-remote-user-display-name': 'Test User' };
  const up = http.request({ ...TARGET, method: req.method, path: req.url.slice(PREFIX.length), headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  req.pipe(up);
}).listen(8123, '127.0.0.1', () => console.log(`HA stand-in on http://127.0.0.1:8123 -> add-on :${TARGET.port}`));
