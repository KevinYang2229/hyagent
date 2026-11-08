/**
 * 守住 tests/helpers/supertest-loopback.ts：request(app) 的臨時 server 必須綁 127.0.0.1。
 * 綁回 `::` 的話，macOS 上偶爾會拿到「別的程式綁在 127.0.0.1」的同號埠，請求被對方接走
 * （整套測試約每三次就有一次隨機失敗於 404 / 405 / Parse Error）。
 */
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';

it('request(app) 的臨時 server 綁在 IPv4 回環', async () => {
  const app = express();
  app.get('/whoami', (req, res) => {
    const server = (req.socket as unknown as { server: { address(): AddressInfo } }).server;
    res.json(server.address());
  });

  const res = await request(app).get('/whoami').expect(200);
  expect(res.body).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
});
