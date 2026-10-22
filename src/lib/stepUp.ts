/**
 * 敏感操作二次验证（step-up）。
 *
 * 后端对敏感管理操作（数据库查询、节点文件写入、插件启停、备份下载等）
 * 要求"近期通过过 2FA"：会话在 /api/admin/2fa/verify 成功后的一段时间内
 * （默认 10 分钟）免输验证码，过期后请求会返回 "2FA code is required"。
 *
 * 这里提供三件事：
 * 1. requestStepUp()：弹出全局验证码对话框，验证成功后 resolve；多个请求
 *    同时触发时共用同一个对话框。
 * 2. installStepUpFetch()：包装 window.fetch，管理接口返回上述错误时自动
 *    弹框并重试一次，页面代码无需改动。
 * 3. ensureStepUp()：用于页面跳转、XHR 上传这类拦截不到响应的场景，
 *    在发起前先确认窗口有效，必要时弹框。
 */

export const STEP_UP_REQUIRED_MESSAGE = "2FA code is required";

const STEP_UP_STATUS_URL = "/api/admin/2fa/status";
const STEP_UP_VERIFY_URL = "/api/admin/2fa/verify";

/** 窗口剩余时间少于这个值时提前要求验证，避免请求途中过期。 */
const STEP_UP_SAFETY_MARGIN_MS = 30_000;

export class StepUpCancelledError extends Error {
  constructor(message = "2FA verification cancelled") {
    super(message);
    this.name = "StepUpCancelledError";
  }
}

export type StepUpPrompt = {
  /** 提交验证码；失败时抛出带后端错误信息的 Error，对话框保持打开。 */
  submit: (code: string) => Promise<void>;
  /** 用户取消。 */
  cancel: () => void;
};

type Listener = (prompt: StepUpPrompt | null) => void;

let currentPrompt: StepUpPrompt | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(currentPrompt);
}

/** 供对话框组件订阅当前是否需要输入验证码。 */
export function subscribeStepUp(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentPrompt);
  return () => {
    listeners.delete(listener);
  };
}

// 保存未被包装的 fetch，避免 verify/status 请求再次进入拦截逻辑。
const rawFetch: typeof fetch =
  typeof window !== "undefined" ? window.fetch.bind(window) : fetch;

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.clone().json();
    if (data && typeof data.message === "string") return data.message;
  } catch {
    // 非 JSON 响应
  }
  return "";
}

/** 调用后端为当前会话开启 step-up 窗口。 */
export async function verifyStepUp(code: string): Promise<void> {
  const trimmed = code.trim();
  const response = await rawFetch(STEP_UP_VERIFY_URL, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-2FA-Code": trimmed,
    },
    body: JSON.stringify({ "2fa_code": trimmed }),
  });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

/**
 * 弹出验证码对话框，直到验证成功（resolve）或用户取消（reject
 * StepUpCancelledError）。并发调用共享同一个对话框。
 */
export function requestStepUp(): Promise<void> {
  if (pending) return pending;
  pending = new Promise<void>((resolve, reject) => {
    if (listeners.size === 0) {
      // 没有挂载对话框（例如受限的引导页面），无法向用户索取验证码。
      reject(new StepUpCancelledError("2FA verification is unavailable on this page"));
      return;
    }
    currentPrompt = {
      submit: async (code: string) => {
        await verifyStepUp(code);
        currentPrompt = null;
        emit();
        resolve();
      },
      cancel: () => {
        currentPrompt = null;
        emit();
        reject(new StepUpCancelledError());
      },
    };
    emit();
  }).finally(() => {
    pending = null;
  });
  return pending;
}

type StepUpStatus = {
  enabled: boolean;
  step_up_valid_until: number;
  window_seconds: number;
};

/** 读取当前会话的 step-up 状态；读取失败时返回 null。 */
export async function fetchStepUpStatus(): Promise<StepUpStatus | null> {
  try {
    const response = await rawFetch(STEP_UP_STATUS_URL, {
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const body = await response.json();
    return (body?.data ?? null) as StepUpStatus | null;
  } catch {
    return null;
  }
}

/**
 * 在无法拦截响应的操作（页面跳转下载、表单跳转、XHR 分片上传）之前调用：
 * 账号开启了 2FA 且窗口即将过期时，先让用户完成验证。
 * 状态读取失败时不阻塞，交给后端最终判定。
 */
export async function ensureStepUp(): Promise<void> {
  const status = await fetchStepUpStatus();
  if (!status || !status.enabled) return;
  const validUntilMs = (status.step_up_valid_until || 0) * 1000;
  if (validUntilMs - Date.now() > STEP_UP_SAFETY_MARGIN_MS) return;
  await requestStepUp();
}

/** 判断错误是否为后端要求 step-up。 */
export function isStepUpRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(STEP_UP_REQUIRED_MESSAGE);
}

/**
 * 包装一次异步调用：如果它因为需要 step-up 失败，弹框验证后重试一次。
 */
export async function withStepUp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isStepUpRequiredError(error)) throw error;
    await requestStepUp();
    return run();
  }
}

function requestPath(input: RequestInfo | URL): string | null {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function shouldIntercept(path: string | null): boolean {
  if (!path || !path.startsWith("/api/admin/")) return false;
  // 2FA 自身的启用/停用/验证接口有独立的输入框，不做自动弹框。
  return !path.startsWith("/api/admin/2fa/");
}

let installed = false;

/**
 * 包装全局 fetch：同源 /api/admin/* 请求返回 401 "2FA code is required" 时，
 * 弹框验证并重试一次。只安装一次。
 */
export function installStepUpFetch(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (!shouldIntercept(path)) return rawFetch(input, init);

    // Request 对象的 body 只能读取一次，重试需要先保留一份副本。
    const retryInput = input instanceof Request ? input.clone() : input;
    const response = await rawFetch(input, init);
    if (response.status !== 401) return response;
    const message = await readErrorMessage(response);
    if (message !== STEP_UP_REQUIRED_MESSAGE) return response;

    try {
      await requestStepUp();
    } catch {
      // 用户取消：把原始的 401 响应交还给调用方，由页面自行提示。
      return response;
    }
    return rawFetch(retryInput, init);
  };
}
