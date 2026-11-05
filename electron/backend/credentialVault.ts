/**
 * df-stores 凭据落盘加密（纯逻辑层，零 Electron 依赖）。
 *
 * 背景：凭据（大模型 API Key、后端令牌、调度令牌）原本以明文 JSON 落在
 * `userData/df-stores/*.json`。同一账户下的其它进程可直接读取，文件被拷贝、
 * 被云盘同步、或被用户打包发给他人时即外泄 —— 计划书风险 R6 的待补项。
 *
 * 本模块只负责「哪些字段敏感 + 信封的编解码」，真正的加解密由调用方注入
 * （主进程注入 Electron safeStorage，它落到系统钥匙串；测试注入假实现），
 * 因此可以在 node 环境下穷举测试，不需要 Electron 运行时。
 *
 * 信封形态：敏感值由字符串 `"<明文>"` 变为对象
 *   { "$dfenc": "v1", "v": "<base64 密文>" }
 * 保留 JSON 结构、自带版本号、读取方一眼可辨（读到对象即知尚未解密）。
 *
 * 兼容策略：明文值原样读出，旧版本文件继续可用；下次写入时自动升级为信封。
 * 降级策略见 `wrap` / `unwrap` 的注释——密钥不可用时明文落盘但必须告警，
 * 而「密钥可用但加密失败」一律 fail-close 置空，绝不把明文写回去。
 */

/** 信封标记字段：值被加密后由字符串变为带此键的对象 */
export const ENVELOPE_MARK = '$dfenc';

/** 当前信封版本。升级算法时递增，旧版本读出即视为不可解 */
export const ENVELOPE_VERSION = 'v1';

/** `stripCredentials` 的替换文本：键保留、值抹掉，便于诊断「缺哪一项」 */
export const REDACTED = '***';

/** 注入的加解密实现 */
export interface CipherPort {
  /** 本机是否具备可用密钥；false 时调用方须明确降级，不得写入信封 */
  available(): boolean;
  /** 加密为 base64 密文；失败应抛错 */
  encrypt(plain: string): string;
  /** 解密 base64 密文；失败应抛错 */
  decrypt(cipherText: string): string;
}

export interface VaultResult {
  /** 处理后的数据（新对象，不改动入参） */
  data: unknown;
  /** 实际完成信封包裹 / 解开的字段数 */
  changed: number;
  /** 处理失败的字段路径；加密失败保留原值（或按 fail-close 置空），解密失败置空 */
  failures: string[];
}

/**
 * 敏感字段判定。按「键名像凭据」匹配，而非按文件名白名单 ——
 * 后者会随新增配置项静默失效（新加一个 provider 的 apiKey 就漏了）。
 *
 * 只匹配值语义明确的词，不用宽泛的 `key`：`gitSshKeyPath`、`privateKeyPath`
 * 这类「指向密钥文件的路径」不是凭据本身，误加密会让用户找不到文件。
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /api[-_]?key/i,
  /access[-_]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
];

export const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_PATTERNS.some(re => re.test(key));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 是否是本站写入的信封（只认标记字段存在，版本校验交给 unwrap） */
const hasEnvelopeMark = (v: unknown): v is Record<string, unknown> =>
  isPlainObject(v) && ENVELOPE_MARK in v;

interface Walk {
  changed: number;
  failures: string[];
}

const childPath = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** 敏感值包装为信封。返回 null 表示「不包装」，由调用方保留原值 */
function wrap(plain: string, cipher: CipherPort, acc: Walk, path: string): Record<string, unknown> | string {
  // 空值不加密：空串与「缺失」在业务上等价，加密只会让配置看起来「已配置」
  if (!plain) return plain;
  // 钥匙串不可用（如无 keyring 的 Linux）：沿用旧行为明文落盘，由调用方告警。
  // 这里不做「假加密」——写入无法解开的密文等于静默丢配置。
  if (!cipher.available()) return plain;
  try {
    return { [ENVELOPE_MARK]: ENVELOPE_VERSION, v: cipher.encrypt(plain) };
  } catch {
    // 密钥可用却加密失败：fail-close。宁可让用户重填一次密钥，
    // 也不能把明文写到磁盘上。
    acc.failures.push(path);
    return '';
  }
}

function walkEncrypt(node: unknown, cipher: CipherPort, path: string, acc: Walk): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => walkEncrypt(item, cipher, `${path}[${i}]`, acc));
  }
  if (isPlainObject(node)) {
    // 已经是信封的值原样保留（幂等）：Store 读写可能来回经过本函数
    if (hasEnvelopeMark(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const p = childPath(path, k);
      out[k] =
        isSensitiveKey(k) && typeof v === 'string'
          ? wrap(v, cipher, acc, p)
          : walkEncrypt(v, cipher, p, acc);
    }
    return out;
  }
  return node;
}

function unwrap(value: unknown, cipher: CipherPort, path: string, acc: Walk): unknown {
  if (!hasEnvelopeMark(value)) return value;
  const version = value[ENVELOPE_MARK];
  const payload = value.v;
  if (version !== ENVELOPE_VERSION || typeof payload !== 'string') {
    // 版本不认识 / 结构损坏：不猜、不返回密文，按「无此凭据」处理
    acc.failures.push(path);
    return '';
  }
  if (!cipher.available()) {
    acc.failures.push(path);
    return '';
  }
  try {
    const plain = cipher.decrypt(payload);
    acc.changed += 1;
    return plain;
  } catch {
    // 换了机器、钥匙串被重置、文件被外人拷贝：解不开。
    // 置空而不是抛错——一个读不到的令牌不该让整个应用起不来。
    acc.failures.push(path);
    return '';
  }
}

function walkDecrypt(node: unknown, cipher: CipherPort, path: string, acc: Walk): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => walkDecrypt(item, cipher, `${path}[${i}]`, acc));
  }
  if (isPlainObject(node)) {
    if (hasEnvelopeMark(node)) return unwrap(node, cipher, path, acc);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = walkDecrypt(v, cipher, childPath(path, k), acc);
    }
    return out;
  }
  return node;
}

/** 写入前调用：把所有敏感值包成信封。入参不被修改 */
export function encryptSensitiveValues(data: unknown, cipher: CipherPort): VaultResult {
  const acc: Walk = { changed: 0, failures: [] };
  const out = walkEncrypt(data, cipher, '', acc);
  return { data: out, changed: countEnvelopes(out), failures: acc.failures };
}

/** 读出后调用：把信封解回明文。解不开的字段置空并记入 failures */
export function decryptSensitiveValues(data: unknown, cipher: CipherPort): VaultResult {
  const acc: Walk = { changed: 0, failures: [] };
  const out = walkDecrypt(data, cipher, '', acc);
  return { data: out, changed: acc.changed, failures: acc.failures };
}

/** 统计信封数量（encrypt 的 changed 语义是「包了多少个」，须实际点数） */
function countEnvelopes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, item) => n + countEnvelopes(item), 0);
  if (isPlainObject(node)) {
    if (hasEnvelopeMark(node)) return 1;
    return Object.values(node).reduce<number>((n, v) => n + countEnvelopes(v), 0);
  }
  return 0;
}

function walkStrip(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((item, i) => walkStrip(item, `${path}[${i}]`));
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (isSensitiveKey(k)) {
        // 敏感字段一律抹掉值。含空值也抹：导出物是要发给别人的，
        // 「这里有个空字段」本身没有诊断价值，而漏一个就是泄露。
        out[k] = REDACTED;
      } else {
        out[k] = walkStrip(v, childPath(path, k));
      }
    }
    return out;
  }
  return node;
}

/**
 * 导出配置时剥离凭据：键保留、值替换为 `***`。
 *
 * 保留键而不是删键，是为了让拿到导出物的人能看出「还差哪一项没配」；
 * 删除只能看出「没这一项」，诊断价值更低。
 */
export function stripCredentials(data: unknown): unknown {
  return walkStrip(data, '');
}
