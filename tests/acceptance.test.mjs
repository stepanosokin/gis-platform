import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';

async function probe(t, respond, expected) {
  const server = createServer(respond);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.env.GIS_TEST_PYTHON, [
    'tests/acceptance.py', `http://127.0.0.1:${server.address().port}`,
    '--workers', '2', '--seconds', '0.1',
  ], { windowsHide: true });
  child.stdin.end(JSON.stringify(expected));
  const [[code], stdout, stderr] = await Promise.all([
    once(child, 'close'), text(child.stdout), text(child.stderr),
  ]);
  return { code, stdout, stderr };
}

test('reports completed concurrent gateway requests and checks the feature count', async (t) => {
  let warmup = true;
  let paired = false;
  let pending;
  const send = (response) => {
    response.setHeader('Content-Type', 'application/geo+json');
    response.end('{"features":[{},{}]}');
  };
  const { code, stdout, stderr } = await probe(t, (request, response) => {
    assert.equal(request.url, '/features');
    if (warmup || paired) {
      warmup = false;
      send(response);
    } else if (pending) {
      paired = true;
      send(pending);
      send(response);
    } else {
      pending = response;
    }
  }, [{ path: '/features', features: 2 }]);
  assert.equal(code, 0, stderr);
  assert.equal(paired, true);
  const report = JSON.parse(stdout);
  assert.equal(report.workers, 2);
  assert.ok(report.cases[0].requests >= 2);
  assert.ok(report.cases[0].p95Ms >= 0);
  assert.equal(report.cases[0].features, 2);
});

test('rejects a PNG with incorrect dimensions', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000002f0000001d', 'hex');
  const { code, stdout, stderr } = await probe(t, (_, response) => {
    response.setHeader('Content-Type', 'image/png');
    response.end(png);
  }, [{ path: '/map', png: [29, 47] }]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /PNG dimensions.*47.*29/);
});

test('rejects a non-200 response even when the body has the expected feature count', async (t) => {
  const { code, stdout, stderr } = await probe(t, (_, response) => {
    response.writeHead(202, { 'Content-Type': 'application/geo+json' });
    response.end('{"features":[]}');
  }, [{ path: '/features', features: 0 }]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /HTTP 202/);
});

test('rejects a redirect before requesting the destination', async (t) => {
  let followed = false;
  const { code, stdout, stderr } = await probe(t, (request, response) => {
    if (request.url === '/features') {
      response.writeHead(302, { Location: '/other' });
      response.end();
    } else {
      followed = true;
      response.end('{"features":[]}');
    }
  }, [{ path: '/features', features: 0 }]);
  assert.equal(followed, false);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /HTTP Error 302/);
});
