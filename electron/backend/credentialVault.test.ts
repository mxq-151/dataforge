// @vitest-environment node
/**
 * 凭据信封的纯逻辑测试。
 *
 * 刻意跑在 node 环境：这份代码是主进程的，只用 Buffer 做假加解密，
 * 不依赖 DOM，也不依赖 Electron —— 被测行为与真实运行环境一致。
 */
import { describe, it, expect } from 'vitest';
import {
  ENVELOPE_MARK,
  ENVELOPE_VERSION,
  REDACTED,
  decryptSensitiveValues,
  encryptSensitiveValues,
  isSensitiveKey,
  stripCredentials,
  type CipherPort,
} from './credentialVault';

/** 假实现：可逆、可观测（密文里含 enc: 前缀便于断言） */
const cipher: CipherPort = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8').toString('base64'),
  decrypt: (cipherText) => {
    const text = Buffer.from(cipherText, 'base64').toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('密文格式不对');
    return text.slice(4);
  },
};

/** 无可用钥匙串（无 keyring 的 Linux） */
const noKeychain: CipherPort = {
  available: () => false,
  encrypt: () => {
    throw new Error('不该被调用');
  },
  decrypt: () => {
    throw new Error('不该被调用');
  },
};

/** 钥匙串可用但加密过程出错 */
const brokenEncrypt: CipherPort = { ...cipher, encrypt: () => { throw new Error('DPAPI 失败'); } };

const envelopeOf = (value: unknown): string =>
  Buffer.from((value as Record<string, string>).v, 'base64').toString('utf8');

describe('isSensitiveKey', () => {
  it.each([
    ['apiKey', true],
    ['api_key', true],
    ['api-key', true],
    ['auth_token', true],
    ['dolphinSchedulerToken', true],
    ['marquezToken', true],
    ['llmSecret', true],
    ['password', true],
    ['passwd', true],
    ['dbCredential', true],
  ])('%s → %s', (key, expected) => {
    expect(isSensitiveKey(key)).toBe(expected);
  });

  it.each([
    // 「指向密钥的路径」不是凭据本身，误加密会让用户找不到文件
    ['gitSshKeyPath', false],
    ['privateKeyPath', false],
    ['modelID', false],
    ['baseUrl', false],
    ['cwd', false],
    ['username', false],
    ['llmModels', false],
    ['', false],
  ])('%s → %s', (key, expected) => {
    expect(isSensitiveKey(key)).toBe(expected);
  });
});

describe('encryptSensitiveValues', () => {
  it('把顶层敏感值包成信封，密文不出现明文', () => {
    const { data, changed, failures } = encryptSensitiveValues(
      { apiKey: 'sk-real-secret', baseUrl: 'http://x' },
      cipher
    );
    const record = data as Record<string, unknown>;
    expect(changed).toBe(1);
    expect(failures).toEqual([]);
    expect(record.baseUrl).toBe('http://x');
    expect(record.apiKey).toMatchObject({ [ENVELOPE_MARK]: ENVELOPE_VERSION });
    expect(envelopeOf(record.apiKey)).toBe('enc:sk-real-secret');
    expect(JSON.stringify(data)).not.toContain('sk-real-secret');
  });

  it('递归处理嵌套对象与数组，failures 记录字段路径', () => {
    const { data, changed } = encryptSensitiveValues(
      { llmModels: [{ name: 'a', apiKey: 'k1' }, { name: 'b', apiKey: 'k2' }] },
      cipher
    );
    const models = (data as { llmModels: Array<Record<string, unknown>> }).llmModels;
    expect(changed).toBe(2);
    expect(models[0].apiKey).toMatchObject({ [ENVELOPE_MARK]: ENVELOPE_VERSION });
    expect(models[1].apiKey).toMatchObject({ [ENVELOPE_MARK]: ENVELOPE_VERSION });
    expect(models[0].name).toBe('a');
    expect(JSON.stringify(data)).not.toContain('k1');
  });

  it('不改动入参', () => {
    const input = { apiKey: 'plain' };
    encryptSensitiveValues(input, cipher);
    expect(input.apiKey).toBe('plain');
  });

  it('空串不加密：留空与未配置语义相同，包成信封会假装「已配置」', () => {
    const { data, changed } = encryptSensitiveValues({ apiKey: '', password: 'x' }, cipher);
    expect(changed).toBe(1);
    expect((data as { apiKey: string }).apiKey).toBe('');
  });

  it('幂等：已是信封的值不会被二次包装', () => {
    const first = encryptSensitiveValues({ apiKey: 'k' }, cipher).data;
    const second = encryptSensitiveValues(first, cipher);
    expect(second.changed).toBe(1);
    expect(second.data).toEqual(first);
  });

  it('钥匙串不可用时保持明文（由调用方告警），不写假密文', () => {
    const { data, changed, failures } = encryptSensitiveValues({ apiKey: 'plain' }, noKeychain);
    expect(changed).toBe(0);
    expect(failures).toEqual([]);
    expect((data as { apiKey: string }).apiKey).toBe('plain');
  });

  it('钥匙串可用但加密失败 → fail-close 置空并记路径，绝不明文落盘', () => {
    const { data, changed, failures } = encryptSensitiveValues(
      { apiKey: 'secret', baseUrl: 'http://x' },
      brokenEncrypt
    );
    expect(changed).toBe(0);
    expect(failures).toEqual(['apiKey']);
    expect((data as { apiKey: string }).apiKey).toBe('');
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('敏感键的值不是字符串时继续下钻（如 {"token": {...}}）', () => {
    const { data } = encryptSensitiveValues({ token: { nested: 'v' } }, cipher);
    expect(data).toEqual({ token: { nested: 'v' } });
  });
});

describe('decryptSensitiveValues', () => {
  it('往返一致：加密 → JSON 序列化 → 读出等于原值', () => {
    const original = {
      apiKey: 'sk-1',
      llmModels: [{ apiKey: 'sk-2', modelID: 'deepseek-v4' }],
      cwd: '/tmp/ws',
    };
    const written = encryptSensitiveValues(original, cipher).data;
    const onDisk = JSON.parse(JSON.stringify(written));
    const { data, changed, failures } = decryptSensitiveValues(onDisk, cipher);
    expect(data).toEqual(original);
    expect(changed).toBe(2);
    expect(failures).toEqual([]);
  });

  it('旧版明文文件照常可读（无需迁移脚本）', () => {
    const { data, changed, failures } = decryptSensitiveValues({ apiKey: 'legacy' }, cipher);
    expect(data).toEqual({ apiKey: 'legacy' });
    expect(changed).toBe(0);
    expect(failures).toEqual([]);
  });

  it('换了机器 / 钥匙串被重置：解不开的字段置空并报路径，不抛错', () => {
    const disk = { apiKey: { [ENVELOPE_MARK]: ENVELOPE_VERSION, v: 'bm90LW1pbmU=' } };
    const { data, failures } = decryptSensitiveValues(disk, cipher);
    expect(failures).toEqual(['apiKey']);
    expect((data as { apiKey: string }).apiKey).toBe('');
  });

  it('信封版本不认识 → 视为未配置，不返回密文', () => {
    const disk = { apiKey: { [ENVELOPE_MARK]: 'v99', v: 'x' } };
    const { data, failures } = decryptSensitiveValues(disk, cipher);
    expect(failures).toEqual(['apiKey']);
    expect((data as { apiKey: string }).apiKey).toBe('');
  });

  it('信封结构损坏（缺 v 字段）同样置空', () => {
    const disk = { apiKey: { [ENVELOPE_MARK]: ENVELOPE_VERSION } };
    const { data, failures } = decryptSensitiveValues(disk, cipher);
    expect(failures).toEqual(['apiKey']);
    expect((data as { apiKey: string }).apiKey).toBe('');
  });

  it('钥匙串不可用时信封一律置空（宁可当没配，也不返回密文）', () => {
    const disk = { apiKey: { [ENVELOPE_MARK]: ENVELOPE_VERSION, v: 'aXg=' } };
    const { data, failures } = decryptSensitiveValues(disk, noKeychain);
    expect(failures).toEqual(['apiKey']);
    expect((data as { apiKey: string }).apiKey).toBe('');
  });

  it('数组内的信封按路径定位', () => {
    const disk = { llmModels: [{ ok: 1 }, { apiKey: { [ENVELOPE_MARK]: ENVELOPE_VERSION, v: 'YmFk' } }] };
    const { failures } = decryptSensitiveValues(disk, cipher);
    expect(failures).toEqual(['llmModels[1].apiKey']);
  });
});

describe('stripCredentials', () => {
  it('顶层与嵌套的敏感值都替换为 ***，非敏感字段原样保留', () => {
    const out = stripCredentials({
      apiKey: 'sk-live',
      baseUrl: 'http://x',
      llmModels: [{ name: 'a', apiKey: 'sk-2' }],
      nested: { auth_token: 'tk' },
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.baseUrl).toBe('http://x');
    expect((out.nested as Record<string, unknown>).auth_token).toBe(REDACTED);
    expect((out.llmModels as Array<Record<string, unknown>>)[0].apiKey).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('sk-live');
  });

  it('保留键而不是删键：导出物要能看出「还差哪一项没配」', () => {
    const out = stripCredentials({ apiKey: '' }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['apiKey']);
    expect(out.apiKey).toBe(REDACTED);
  });

  it('不改动入参', () => {
    const input = { apiKey: 'plain' };
    stripCredentials(input);
    expect(input.apiKey).toBe('plain');
  });

  it('数组与标量原样透传', () => {
    expect(stripCredentials([1, 'a', null])).toEqual([1, 'a', null]);
    expect(stripCredentials('text')).toBe('text');
    expect(stripCredentials(null)).toBeNull();
  });
});
