import bcrypt from 'bcrypt';

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 帳號不存在時拿來做假比對，讓回應時間與「密碼錯誤」一致 */
export const DUMMY_HASH = bcrypt.hashSync('hyagent-dummy-password', COST);
