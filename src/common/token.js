import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, E } from './errors.js';

// D16：HMAC 无状态令牌，仅用于 WS hello 帧鉴权（REST 身份由云通道注入的请求头承载）
// 格式：b64url(JSON{openid,iat,exp}).b64url(hmacSha256(secret, payload))
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export class TokenService {
  constructor({ secret, ttlDays = 30 }) {
    this.secret = secret;
    this.ttlSeconds = ttlDays * 86400;
  }

  issue(openid) {
    const iat = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({ openid, iat, exp: iat + this.ttlSeconds }));
    const sig = b64url(createHmac('sha256', this.secret).update(payload).digest());
    return `${payload}.${sig}`;
  }

  verify(token) {
    let parts;
    try {
      parts = String(token).split('.');
      if (parts.length !== 2) throw new Error('bad format');
      const [payload, sig] = parts;
      const expected = b64url(createHmac('sha256', this.secret).update(payload).digest());
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof decoded.openid !== 'string' || !decoded.openid) throw new Error('bad payload');
      if (typeof decoded.exp !== 'number' || decoded.exp <= Math.floor(Date.now() / 1000)) {
        throw new Error('expired');
      }
      return decoded;
    } catch {
      throw new AppError(E.AUTH_INVALID, '令牌无效或已过期');
    }
  }
}
