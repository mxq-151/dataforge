import CryptoJS from 'crypto-js';

const AES_KEY = 'Bigdata2026AesK@';

/**
 * AES-ECB/PKCS5Padding 加密，密码 + 13位时间戳拼接后加密，Base64 编码
 * 与后端 AesUtils.decryptPassword() 对应
 */
export function aesEncryptWithTimestamp(password: string): string {
  const timestamp = String(Date.now());
  const plainText = password + timestamp;
  const key = CryptoJS.enc.Utf8.parse(AES_KEY);
  const encrypted = CryptoJS.AES.encrypt(plainText, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.toString();
}
