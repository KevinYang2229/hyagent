#!/usr/bin/env node
/**
 * HyAgent Identity Assertion 金鑰對產生器（規格 §2、§3）。
 *
 * **這支程式跑在客戶自己的環境**，不是 HyAgent 的服務端。規格 §2.2 要求金鑰對必須在
 * 客戶自有的可信環境產生，HyAgent 不會也不得代為產生或保管私鑰——「HyAgent 沒有能力
 * 偽造任何一位使用者的身分」這句話就是靠這一點成立的。
 *
 * ## 為什麼是單一 .mjs 檔、而且不 import 任何東西
 *
 * 交付對象是客戶的維運人員，執行環境可能是一台剛裝好的機器、CI runner，或連不到外網的
 * 內網主機。任何 `npm install`、建置步驟或 TypeScript 載入器都是一道可能卡住的關卡，
 * 而這支程式一年只跑一兩次（導入 + 輪替），沒有人會為它維護一套工具鏈。
 * 因此：複製這一個檔案過去，`node keygen.mjs ES256 ./keys` 就結束。
 *
 * 代價是 computeKid() 與 `sdk/src/assertion.ts`、`server/src/lib/assertion/keygen.ts`
 * 有三份實作。kid 算錯的後果很隱晦（客戶手上的 kid 與後台顯示的對不起來，但兩邊都說不出
 * 哪裡錯），所以 `sdk/src/keygen-cli.test.ts` 會實際跑這支 CLI 並比對 kid，
 * 三份實作有任何一份漂移都會在測試裡當場失敗。
 *
 * ## 用法
 *
 *   node keygen.mjs [RS256|ES256] [輸出目錄] [--modulus <bits>]
 *   node keygen.mjs --kid <PEM 檔>        # 核對既有公鑰的 kid（OpenSSL 產生時用）
 *
 * 需求：Node.js 18 以上。無任何相依套件。
 */
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** 規格 §2.1 支援的演算法。 */
const SUPPORTED_ALGORITHMS = ['RS256', 'ES256'];

/** 規格 §2.1：RSA modulus 下限。 */
const MIN_RSA_MODULUS_BITS = 2048;

/** 取得公鑰 JWK；傳入私鑰時自動取其對應公鑰。 */
function exportPublicJwk(key) {
  const publicKey =
    typeof key === 'object' && key !== null && key.type === 'public' ? key : createPublicKey(key);
  return publicKey.export({ format: 'jwk' });
}

/**
 * 依 RFC 7638 計算 JWK Thumbprint，即 HyAgent 的 kid（規格 §2.4）。
 * 傳公鑰或私鑰結果相同。
 */
function computeKid(key) {
  const jwk = exportPublicJwk(key);
  // Canonical JWK 的欄位與順序由 RFC 7638 固定，不得增減或重排，否則算出的 kid 會對不上。
  const canonical =
    jwk.kty === 'RSA'
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

/** 由金鑰型別推得規格 §2.1 允許的演算法。 */
function detectAlgorithm(key) {
  const jwk = exportPublicJwk(key);
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  throw new TypeError('金鑰型別不符規格 §2.1，僅支援 RSA 或 EC P-256');
}

function die(message) {
  console.error(`錯誤：${message}`);
  process.exit(1);
}

function usage() {
  const me = basename(process.argv[1] ?? 'keygen.mjs');
  return [
    'HyAgent Identity Assertion 金鑰對產生器（規格 §2、§3）',
    '',
    '用法：',
    `  node ${me} [RS256|ES256] [輸出目錄] [選項]`,
    `  node ${me} --kid <公鑰或私鑰 PEM 檔>`,
    '',
    '參數：',
    '  演算法        RS256（RSA ≥2048）或 ES256（EC P-256，建議）。預設 ES256',
    '  輸出目錄      預設 ./keys，不存在會自動建立',
    '',
    '選項：',
    `  --modulus <bits>   RS256 的 modulus 長度，預設 ${MIN_RSA_MODULUS_BITS}（不得低於此值）`,
    '  --kid <PEM 檔>     只計算既有金鑰的 kid，不產生新金鑰（核對用，見規格 §3.3）',
    '  -h, --help         顯示本說明',
    '',
    '範例：',
    `  node ${me} ES256 ./keys`,
    `  node ${me} RS256 ./keys --modulus 3072`,
    `  node ${me} --kid ./keys/hyagent-xxx.public.pem`,
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { alg: null, outDir: null, modulus: MIN_RSA_MODULUS_BITS, kidOf: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--modulus') {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value)) die('--modulus 必須是整數');
      opts.modulus = value;
    } else if (arg === '--kid') {
      opts.kidOf = argv[++i];
      if (!opts.kidOf) die('--kid 後面要接 PEM 檔路徑');
    } else if (arg.startsWith('-')) {
      die(`未知的選項 ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }

  // 演算法與輸出目錄都是位置參數，但演算法可省略，因此以「看起來像不像演算法」判斷，
  // 而不是靠順序——`keygen ./keys` 這種寫法也要能正確理解。
  for (const arg of positional) {
    const upper = arg.toUpperCase();
    if (SUPPORTED_ALGORITHMS.includes(upper)) {
      opts.alg = upper;
    } else if (/^(?:[HRE]S|PS)\d{3}$|^NONE$/.test(upper)) {
      // 長得像演算法卻不在清單內：當成打錯的演算法名，不要默默拿去當輸出目錄用。
      // HS256 會走到這裡是刻意的——對稱演算法雙方都持有密鑰，規格 §2.1 明文不得使用。
      die(`不支援的演算法 ${arg}，僅接受 ${SUPPORTED_ALGORITHMS.join(' 或 ')}（規格 §2.1）`);
    } else if (opts.outDir === null) {
      opts.outDir = arg;
    } else {
      die(`多餘的參數 ${arg}\n\n${usage()}`);
    }
  }

  opts.alg ??= 'ES256';
  opts.outDir ??= './keys';
  return opts;
}

/** --kid：核對既有金鑰（例如以 OpenSSL 產生的）的 kid 與演算法。 */
function printKidOf(pemPath) {
  const path = resolve(pemPath);
  if (!existsSync(path)) die(`找不到檔案 ${path}`);
  let pem;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (err) {
    die(`讀不到 ${path}：${err.message}`);
  }
  let alg;
  let kid;
  try {
    alg = detectAlgorithm(pem);
    kid = computeKid(pem);
  } catch (err) {
    die(`${path} 不是有效的金鑰：${err.message}`);
  }
  console.log(JSON.stringify({ alg, kid }, null, 2));
  console.log('');
  console.log('把這個 kid 與 HyAgent 後台顯示的值核對；不一致代表上傳的不是這把公鑰。');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.kidOf) {
    printKidOf(opts.kidOf);
    return;
  }

  if (opts.alg === 'RS256' && opts.modulus < MIN_RSA_MODULUS_BITS) {
    die(`規格 §2.1 要求 RSA modulus 至少 ${MIN_RSA_MODULUS_BITS} bits`);
  }

  const { publicKey, privateKey } =
    opts.alg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: opts.modulus });

  const kid = computeKid(publicKey);
  // 規格 §2.3：公鑰 SPKI、私鑰 PKCS#8，皆為 PEM。
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  // 檔名帶 kid：輪替期間會有兩把金鑰並存（規格 §2.5），檔名認得出誰是誰才不會停用錯的那把。
  const publicPath = join(outDir, `hyagent-${kid}.public.pem`);
  const privatePath = join(outDir, `hyagent-${kid}.private.pem`);

  // 不需要「檔案已存在就拒絕」的保護：kid 是公鑰內容的雜湊，新產生的金鑰不會與既有檔案
  // 同名；真的同名就代表那是同一把金鑰，覆寫寫回去的內容也一樣。檔名本身就是保護。

  writeFileSync(publicPath, publicKeyPem, { encoding: 'utf8' });
  // 先以 0600 建立再寫入，避免「先用預設權限落地、之後才收緊」那一瞬間的可讀窗口。
  writeFileSync(privatePath, privateKeyPem, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(privatePath, 0o600); // 檔案已存在時 mode 不生效，補一次
  } catch {
    // Windows 不吃 POSIX 權限位元，失敗屬正常；提示改由下方 NTFS 說明處理
  }

  console.log(JSON.stringify({ alg: opts.alg, kid }, null, 2));
  console.log(publicKeyPem.trim());
  console.log('');
  console.log(`已寫入：`);
  console.log(`  ${publicPath}    ← 上傳 HyAgent 後台`);
  console.log(`  ${privatePath}   ← 自行保管，絕不外流`);
  console.log('');
  console.log('接下來：');
  console.log('  1. 公鑰貼進 HyAgent 後台的「Assertion 公鑰」，確認後台顯示的 kid 與上面這串一致');
  console.log('  2. 私鑰放進貴方後端的 KMS / Vault / 環境變數，不要進版控（規格 §2.2）');
  if (process.platform === 'win32') {
    console.log('  3. Windows 無 POSIX 權限位元：請以 NTFS ACL 限制私鑰檔僅服務帳號可讀');
  }
}

main();
