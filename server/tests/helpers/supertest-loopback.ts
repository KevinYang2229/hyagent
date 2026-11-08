/**
 * supertest 綁定 IPv4 回環（jest moduleNameMapper 把 `supertest` 指到這裡）。
 *
 * 原版 `request(app)` 對每個請求呼叫 `server.listen(0)`：未指定 host 時 Node 綁雙棧 `::`，
 * 卻固定連 `http://127.0.0.1:<port>`。macOS 分配臨時埠時不會避開「別的程式只綁在
 * 127.0.0.1」的同號埠（實測 GitKraken、Chrome、LINE 等桌面程式都會佔），而 127.0.0.1
 * 的連線會優先交給較特定的 IPv4 監聽者——請求於是打到別的程式，測試隨機收到
 * 404 / 405 / `Parse Error: Expected HTTP/`，每次落在不同測試檔、單跑又必過。
 *
 * 改為明確綁 127.0.0.1：同位址同埠核心不會重複分配，連線一定回到自己的 server。
 * 帶 host 的 listen 是非同步綁定（原版靠無 host 的同步綁定在建構子裡就拿到埠號），
 * 所以建構時只啟動 listen，等到 end()（await / .then / .expect(cb) 都經過它）
 * 確定 listening 後才組出實際網址送出請求。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as TlsServer } from 'node:tls';

type SupertestModule = typeof import('supertest');
type EndCallback = (err: unknown, res?: unknown) => void;

interface LoopbackTest {
  url: string;
  _server?: Server;
  _loopbackApp?: Server;
  _loopbackPath?: string;
  serverAddress(app: Server, path: string): string;
  end(fn?: EndCallback): LoopbackTest;
}

/** 同一個 server 正在綁定中（TestAgent 會讓多個 Test 共用一個 server）：避免重複 listen */
const binding = new WeakSet<Server>();

// 以實際檔案路徑載入原版，避開 moduleNameMapper 的 `^supertest$` 對應回本檔
const supertest = require('supertest/index.js') as SupertestModule;
const proto = supertest.Test.prototype as unknown as LoopbackTest;
const originalEnd = proto.end;

function urlFor(app: Server, path: string): string {
  const addr = app.address() as AddressInfo | null;
  const protocol = app instanceof TlsServer ? 'https' : 'http';
  // 尚未綁定完成時先放埠號 0；end() 會在 listening 後重組
  return `${protocol}://127.0.0.1:${addr?.port ?? 0}${path}`;
}

proto.serverAddress = function serverAddress(this: LoopbackTest, app: Server, path: string): string {
  this._loopbackApp = app;
  this._loopbackPath = path;
  if (!app.address() && !binding.has(app)) {
    binding.add(app);
    const settle = () => binding.delete(app);
    app.once('listening', settle);
    app.once('error', settle);
    this._server = app.listen(0, '127.0.0.1');
  }
  return urlFor(app, path);
};

proto.end = function end(this: LoopbackTest, fn?: EndCallback): LoopbackTest {
  const app = this._loopbackApp;
  if (!app || app.address() || !binding.has(app)) {
    if (app && app.address()) this.url = urlFor(app, this._loopbackPath ?? '');
    return originalEnd.call(this, fn);
  }
  const onListening = () => {
    app.off('error', onError);
    this.url = urlFor(app, this._loopbackPath ?? '');
    originalEnd.call(this, fn);
  };
  const onError = (err: unknown) => {
    app.off('listening', onListening);
    fn?.(err);
  };
  app.once('listening', onListening);
  app.once('error', onError);
  return this;
};

module.exports = supertest;
