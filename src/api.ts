import { mockLive, mockNodes, mockSettings } from './mock';
import type { LiveState, NodeInfo, PublicSettings } from './types';

/** 单次 HTTP 请求超时：避免请求挂起后轮询链永远无法自愈。 */
const REQUEST_TIMEOUT_MS = 8000;
/** 逐节点明细请求的并发上限，避免一次性对全部节点全量并发。 */
const PING_CONCURRENCY = 6;
/** 旧版 WebSocket 回退连续失败上限，超过后停止刷连接并降级。 */
const LEGACY_SOCKET_MAX_FAILURES = 5;

type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };

const signalTimeout = (milliseconds: number): AbortSignal | null => {
  const candidate = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  return typeof candidate === 'function' ? candidate.call(AbortSignal, milliseconds) : null;
};

/**
 * 为一次请求生成带超时的 signal：优先使用 AbortSignal.timeout，
 * 不可用时回退到 setTimeout + AbortController；调用方传入的 signal 会被透传（任一触发即取消）。
 */
function timeoutSignal(options: RequestOptions = {}) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const external = options.signal;
  if (!external) {
    const signal = signalTimeout(timeoutMs);
    if (signal) return { signal, cleanup: () => undefined };
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', forwardAbort);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timer);
      external?.removeEventListener('abort', forwardAbort);
    },
  };
}

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { signal, cleanup } = timeoutSignal(options);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = await response.json();
    if (payload?.status && payload.status !== 'success') throw new Error(payload.message || '请求失败');
    return payload?.data ?? payload;
  } finally {
    cleanup();
  }
}

/** 受限并发池：按固定上限并发执行 worker，结果顺序与输入一致。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function loadInitialData() {
  try {
    const [settings, nodes] = await Promise.all([
      request<PublicSettings>('/api/public'),
      request<NodeInfo[]>('/api/nodes'),
    ]);
    return { settings, nodes, live: {} as Record<string, LiveState>, demo: false };
  } catch {
    return { settings: mockSettings, nodes: mockNodes, live: mockLive, demo: true };
  }
}

type PingRecords = {
  records?: Array<{ task_id?: number | string; value?: number; time?: string }>;
  tasks?: Array<{ id?: number | string; task_id?: number | string; name?: string; avg?: number }>;
};

export type NetworkLatency = { taskId: number; name: string; latency: number | null };

export async function loadPingLatencies(nodeIds: string[], signal?: AbortSignal) {
  let hasTasks = false;
  try {
    const tasks = await request<Array<Record<string, unknown>>>('/api/task/ping', { signal });
    hasTasks = Array.isArray(tasks) && tasks.some((task) => task.enabled !== false && task.disabled !== true);
  } catch {
    // 旧版 Komari 可能没有公开任务端点，保留历史记录兼容路径。
    hasTasks = true;
  }

  if (!hasTasks) {
    return { values: Object.fromEntries(nodeIds.map((uuid) => [uuid, null])) as Record<string, number | null>, hasTasks: false };
  }

  const entries = await mapWithConcurrency(nodeIds, PING_CONCURRENCY, async (uuid) => {
    try {
      const data = await request<PingRecords>(`/api/records/ping?uuid=${encodeURIComponent(uuid)}&hours=1`, { signal });
      const taskValues = (data.tasks || []).map((task) => Number(task.avg)).filter((value) => Number.isFinite(value) && value >= 0);
      if (taskValues.length) return [uuid, Math.round(taskValues.reduce((sum, value) => sum + value, 0) / taskValues.length)] as const;
      const latest = [...(data.records || [])].reverse().find((record) => Number(record.value) >= 0);
      return [uuid, latest ? Math.round(Number(latest.value)) : null] as const;
    } catch {
      return [uuid, null] as const;
    }
  });
  return { values: Object.fromEntries(entries) as Record<string, number | null>, hasTasks: true };
}

export async function loadNetworkLatencies(nodeIds: string[], taskNames: string[], signal?: AbortSignal) {
  const normalizedNames = [...new Set(taskNames.map((name) => name.trim()).filter(Boolean))];
  if (!normalizedNames.length) return {} as Record<string, NetworkLatency[]>;
  let activeTaskNames: Set<string> | null = null;
  try {
    const activeTasks = await request<Array<{ name?: string; enabled?: boolean; disabled?: boolean }>>('/api/task/ping', { signal });
    activeTaskNames = new Set(activeTasks
      .filter((task) => task.enabled !== false && task.disabled !== true)
      .map((task) => task.name?.trim())
      .filter((name): name is string => Boolean(name)));
  } catch {
    // 旧版或未公开任务端点时，使用记录接口返回的任务列表。
  }

  const entries = await mapWithConcurrency(nodeIds, PING_CONCURRENCY, async (uuid) => {
    try {
      const data = await request<PingRecords>(`/api/records/ping?uuid=${encodeURIComponent(uuid)}&hours=1`, { signal });
      const tasks = data.tasks || [];
      const records = data.records || [];
      const values = normalizedNames.flatMap<NetworkLatency>((configuredName) => {
        if (activeTaskNames && !activeTaskNames.has(configuredName)) return [];
        const task = tasks.find((candidate) => candidate.name?.trim() === configuredName);
        if (!task) return [];
        const taskId = Number(task.id ?? task.task_id);
        if (!Number.isFinite(taskId) || taskId <= 0) return [];
        const taskAverage = typeof task.avg === 'number' ? task.avg : Number.NaN;
        if (Number.isFinite(taskAverage) && taskAverage >= 0) {
          return [{ taskId, name: configuredName, latency: Math.round(taskAverage) }];
        }
        const samples = records
          .filter((record) => Number(record.task_id) === taskId)
          .map((record) => Number(record.value))
          .filter((value) => Number.isFinite(value) && value >= 0);
        if (!samples.length) return [{ taskId, name: configuredName, latency: null }];
        return [{ taskId, name: configuredName, latency: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length) }];
      });
      return [uuid, values] as const;
    } catch {
      return [uuid, []] as const;
    }
  });
  return Object.fromEntries(entries) as Record<string, NetworkLatency[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 归一化旧版 WebSocket 帧：online 必须是字符串数组，否则从 data 的 keys 推导。 */
const normalizeLegacyFrame = (payload: unknown) => {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  const live = payload.data as Record<string, LiveState>;
  const online = Array.isArray(payload.online)
    ? payload.online.map((uuid: unknown) => String(uuid))
    : Object.keys(live);
  return { online, live };
};

export function connectLive(
  onData: (online: string[], live: Record<string, LiveState>) => void,
  onStatus: (connected: boolean) => void,
  requestedInterval = 3000,
) {
  if (!location.protocol.startsWith('http')) return () => undefined;
  const interval = Math.max(1000, Math.min(60000, requestedInterval));
  // 单次轮询请求超时：至少 5s，且不小于轮询间隔，避免正常的长间隔被误判超时。
  const pollTimeout = Math.max(5000, interval);
  let timer: number | undefined;
  let controller: AbortController | undefined;
  let timeoutTimer: number | undefined;
  let legacySocket: WebSocket | undefined;
  let legacyFailures = 0;
  let stopped = false;
  let running = false;
  let requestId = 0;

  const schedule = () => {
    if (!stopped && !document.hidden) timer = window.setTimeout(refresh, interval);
  };

  const openLegacySocket = () => {
    if (stopped || legacyFailures >= LEGACY_SOCKET_MAX_FAILURES) return;
    if (legacySocket && legacySocket.readyState < WebSocket.CLOSING) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${scheme}//${location.host}/api/clients`);
    } catch {
      // 构造失败（地址非法、被策略拦截等）：计数并放弃本轮，不再抛未处理拒绝。
      legacyFailures += 1;
      legacySocket = undefined;
      return;
    }
    legacySocket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      legacyFailures = 0;
      socket.send('get');
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const payload = message?.data?.data ? message.data : message?.data;
        const frame = normalizeLegacyFrame(payload);
        if (frame && !stopped) {
          // 收到有效数据即认为回退通道恢复。
          legacyFailures = 0;
          onData(frame.online, frame.live);
          onStatus(true);
        }
      } catch { /* ignore malformed legacy frames */ }
    };
    socket.onerror = () => { legacyFailures += 1; socket.close(); };
    socket.onclose = () => {
      if (!opened) legacyFailures += 1;
      if (legacySocket === socket) legacySocket = undefined;
    };
  };

  const refresh = async () => {
    if (stopped || running || document.hidden) return;
    running = true;
    const active = new AbortController();
    controller = active;
    let timedOut = false;
    timeoutTimer = window.setTimeout(() => {
      timedOut = true;
      active.abort();
    }, pollTimeout);
    try {
      const response = await fetch('/api/rpc2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'common:getNodesLatestStatus', id: ++requestId }),
        signal: active.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(payload.error.message || 'RPC2 request failed');
      const result = payload?.result ?? {};
      const online: string[] = [];
      const live: Record<string, LiveState> = {};

      for (const [uuid, raw] of Object.entries(result as Record<string, Record<string, unknown>>)) {
        const value = raw || {};
        if (value.online) online.push(String(value.client || uuid));
        live[uuid] = {
          cpu: { usage: Number(value.cpu) || 0 },
          ram: { used: Number(value.ram) || 0, total: Number(value.ram_total) || 0 },
          swap: { used: Number(value.swap) || 0, total: Number(value.swap_total) || 0 },
          disk: { used: Number(value.disk) || 0, total: Number(value.disk_total) || 0 },
          network: {
            up: Number(value.net_out) || 0,
            down: Number(value.net_in) || 0,
            totalUp: Number(value.net_total_out ?? value.net_total_up) || 0,
            totalDown: Number(value.net_total_in ?? value.net_total_down) || 0,
          },
          load: {
            load1: Number(value.load) || 0,
            load5: Number(value.load5) || 0,
            load15: Number(value.load15) || 0,
          },
          connections: {
            tcp: Number(value.connections) || 0,
            udp: Number(value.connections_udp) || 0,
          },
          uptime: Number(value.uptime) || 0,
          process: Number(value.process) || 0,
          ping: Object.fromEntries(
            Object.entries((value.ping || {}) as Record<string, unknown>)
              .map(([key, ping]) => [key, Number(ping)] as const)
              .filter(([, ping]) => Number.isFinite(ping) && ping >= 0),
          ),
          updated_at: String(value.time || ''),
        };
      }

      if (!stopped) {
        legacySocket?.close();
        legacySocket = undefined;
        onData(online, live);
        onStatus(true);
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      // 只有「超时主动 abort」才视为连接异常；清理时的 abort（stopped）不改变状态。
      if (!stopped && (!aborted || timedOut)) {
        onStatus(false);
        openLegacySocket();
      }
    } finally {
      if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
      controller = undefined;
      running = false;
      schedule();
    }
  };

  const handleVisibility = () => {
    if (timer) window.clearTimeout(timer);
    timer = undefined;
    if (!document.hidden) void refresh();
  };

  document.addEventListener('visibilitychange', handleVisibility);
  void refresh();
  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
    controller?.abort();
    legacySocket?.close();
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}
