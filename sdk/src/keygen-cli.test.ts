/**
 * `bin/keygen.mjs` 的測試（規格 §2、§3）。
 *
 * 這支 CLI 交付給**客戶**在自己的環境執行，因此刻意不 import 任何模組，自己帶了一份
 * computeKid()——全專案第三份（另兩份在 `sdk/src/assertion.ts` 與
 * `server/src/lib/assertion/keygen.ts`）。
 *
 * 三份實作漂移的後果很隱晦：客戶手上的 kid 與 HyAgent 後台顯示的對不起來，兩邊都說不出
 * 哪裡錯，而症狀要等到第一次換發被 `UNKNOWN_KID` 拒絕才出現。所以這裡不測 CLI 的輸出
 * 長什麼樣，測的是**它算出來的 kid 與另外兩份一致**：
 *
 *   CLI ↔ SDK   以同一把公鑰交叉比對 computeKid()
 *   CLI ↔ RFC   以 RFC 7638 §3.1 官方測試向量比對（server 端測試釘的是同一個向量，
 *               三份實作因此被釘在同一個點上）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeKid, detectAlgorithm, issueAssertion } from './server';

const CLI = fileURLToPath(new URL('../bin/keygen.mjs', import.meta.url));

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'hyagent-keygen-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 跑一次 CLI，回傳 stdout。非零離開碼會丟出（含 stderr）。 */
function run(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function runExpectFailure(...args: string[]): string {
  try {
    run(...args);
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    expect(e.status).not.toBe(0);
    return e.stderr ?? '';
  }
  throw new Error('預期 CLI 應以非零離開碼結束，但它成功了');
}

/** 從 stdout 取出開頭那段 JSON 與公鑰 PEM。 */
function parseOutput(stdout: string): { alg: string; kid: string; publicKeyPem: string } {
  const json = JSON.parse(stdout.slice(0, stdout.indexOf('}') + 1)) as { alg: string; kid: string };
  const pem = stdout.slice(
    stdout.indexOf('-----BEGIN PUBLIC KEY-----'),
    stdout.indexOf('-----END PUBLIC KEY-----') + '-----END PUBLIC KEY-----'.length,
  );
  return { ...json, publicKeyPem: pem };
}

describe('產生金鑰對', () => {
  it('ES256：輸出的 kid 與 SDK 的 computeKid() 一致', () => {
    const dir = join(workDir, 'es256');
    const { alg, kid, publicKeyPem } = parseOutput(run('ES256', dir));

    expect(alg).toBe('ES256');
    // 這一行是本檔的重點：CLI 自帶的實作與 SDK 的必須算出同一個 kid。
    expect(computeKid(publicKeyPem)).toBe(kid);
    expect(detectAlgorithm(publicKeyPem)).toBe('ES256');
    expect(kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('寫出的兩個檔案符合規格 §2.3 的編碼，檔名帶 kid', () => {
    const dir = join(workDir, 'files');
    const { kid } = parseOutput(run('ES256', dir));

    const files = readdirSync(dir).sort();
    expect(files).toEqual([`hyagent-${kid}.private.pem`, `hyagent-${kid}.public.pem`]);

    const publicPem = readFileSync(join(dir, `hyagent-${kid}.public.pem`), 'utf8');
    const privatePem = readFileSync(join(dir, `hyagent-${kid}.private.pem`), 'utf8');
    // 規格 §2.3：公鑰 SPKI、私鑰 PKCS#8。私鑰若寫成 SEC1（`BEGIN EC PRIVATE KEY`）
    // 客戶把它餵進 issueAssertion 仍可用，但與規格寫的格式不符，文件就對不上了。
    expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(privatePem).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    // 產出的私鑰要真的能簽出一張合規的 Assertion——否則交付給客戶的是一組廢金鑰。
    const assertion = issueAssertion({
      privateKey: privatePem,
      tenant: 'a3f19c2d84b7e061',
      subject: '507',
    });
    const [header] = assertion.split('.');
    const decoded = JSON.parse(Buffer.from(header!, 'base64url').toString()) as { kid: string };
    expect(decoded.kid).toBe(kid);
  });

  // RSA 金鑰產生的耗時隨機且可能達數秒，逾時放寬到 60 秒，避免在慢機器上變成假失敗。
  it(
    'RS256 的 --modulus 確實生效',
    () => {
      const { kid, publicKeyPem } = parseOutput(run('RS256', join(workDir, 'rsa'), '--modulus', '3072'));
      const key = createPublicKey(publicKeyPem);

      expect(key.asymmetricKeyDetails?.modulusLength).toBe(3072);
      expect(computeKid(publicKeyPem)).toBe(kid);
    },
    60_000,
  );

  it('省略演算法時預設 ES256（規格 §2.1 建議新導入優先採用）', () => {
    expect(parseOutput(run(join(workDir, 'default-alg'))).alg).toBe('ES256');
  });
});

describe('--kid 核對既有金鑰', () => {
  it('公鑰與私鑰算出同一個 kid', () => {
    const dir = join(workDir, 'verify');
    const { kid } = parseOutput(run('ES256', dir));

    const fromPublic = JSON.parse(run('--kid', join(dir, `hyagent-${kid}.public.pem`)).split('\n\n')[0]!);
    const fromPrivate = JSON.parse(run('--kid', join(dir, `hyagent-${kid}.private.pem`)).split('\n\n')[0]!);

    expect(fromPublic.kid).toBe(kid);
    expect(fromPrivate.kid).toBe(kid);
  });

  it('符合 RFC 7638 §3.1 官方測試向量', () => {
    // server/tests/assertion-keygen.test.ts 釘的是同一個向量：兩邊都過，代表三份實作同步。
    const jwk = {
      kty: 'RSA',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
    };
    const pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    const pemPath = join(workDir, 'rfc7638.public.pem');
    writeFileSync(pemPath, pem);

    const out = JSON.parse(run('--kid', pemPath).split('\n\n')[0]!) as { kid: string };
    expect(out.kid).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });
});

describe('拒絕不合規的輸入', () => {
  it('對稱演算法被擋下，且訊息指出規格出處', () => {
    // 靜默把 HS256 當成輸出目錄名是最糟的行為：使用者以為產出了 HMAC 金鑰。
    expect(runExpectFailure('HS256', join(workDir, 'hs256'))).toMatch(/不支援的演算法.*§2\.1/s);
  });

  it('RSA modulus 低於 2048 被擋下（規格 §2.1）', () => {
    // 這條在產生金鑰前就擋下，不會真的跑 1024 bits 的 keygen，因此很快。
    expect(runExpectFailure('RS256', join(workDir, 'weak'), '--modulus', '1024')).toMatch(/2048/);
  });

  it('--kid 遇到不是金鑰的檔案時明確報錯，不會印出一個看似有效的 kid', () => {
    const junk = join(workDir, 'not-a-key.pem');
    writeFileSync(junk, ['-----BEGIN PUBLIC KEY-----', 'nope', '-----END PUBLIC KEY-----', ''].join('\n'));
    expect(runExpectFailure('--kid', junk)).toMatch(/不是有效的金鑰/);
  });
});
