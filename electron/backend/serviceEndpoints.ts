/**
 * 本地服务端点注册表。
 *
 * 背景：opencode 启动子进程时需要把 compile server 的 port/token 注入环境变量，
 * 于是 electron/backend/opencode.ts 直接 import compileServer 读取其运行时状态——
 * 一个 AI 会话模块因此依赖了编译服务模块，两者的生命周期被绑在一起。
 *
 * 改为注册式解耦：compileServer 启动后把自己的端点「提供者」登记到这里，
 * opencode 只依赖这个与领域无关的注册表。依赖方向变为
 *   opencode      → serviceEndpoints
 *   compileServer → serviceEndpoints
 * 两个领域模块互不 import，可独立演进与测试。
 */

export interface CompileServerEndpoint {
  port: number;
  token: string;
}

type CompileEndpointProvider = () => CompileServerEndpoint | null;

let compileEndpointProvider: CompileEndpointProvider | null = null;

/**
 * 由 compileServer 注册（启动时）与注销（停止时）。
 * 注册的是「提供者函数」而非快照值，因此端点端口在 listen 回调里确定也无妨——
 * 每次读取都拿到最新状态。
 */
export function setCompileEndpointProvider(provider: CompileEndpointProvider | null): void {
  compileEndpointProvider = provider;
}

/** 读取编译服务端点；编译服务未启动或未注册时返回 null（调用方需自行降级） */
export function getCompileServerEndpoint(): CompileServerEndpoint | null {
  if (!compileEndpointProvider) return null;
  try {
    return compileEndpointProvider();
  } catch {
    return null;
  }
}
