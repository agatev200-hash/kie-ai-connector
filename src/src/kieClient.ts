/**
 * Minimal client for the Kie.ai REST API (https://docs.kie.ai).
 *
 * Kie.ai is asynchronous: creating a task returns a `taskId` immediately,
 * and the actual image/video is produced in the background. The result is
 * fetched afterwards by polling a "record info" endpoint with that taskId.
 *
 * This client covers two endpoint families:
 *  - The generic "Jobs" API (`/api/v1/jobs/createTask` + `/api/v1/jobs/recordInfo`),
 *    which is shared by most Kie.ai "Market" models (Flux Kontext, Nano Banana,
 *    Grok Imagine, Midjourney, etc.) — you pick the model by its slug.
 *  - The dedicated GPT-Image (`gpt4o-image`) endpoints, which predate the
 *    generic Jobs API and have their own request/response shape.
 */

const KIE_BASE_URL = process.env.KIE_AI_BASE_URL?.replace(/\/+$/, "") || "https://api.kie.ai";

export class KieApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "KieApiError";
  }
}

function getApiKey(): string {
  const key = process.env.KIE_AI_API_KEY;
  if (!key) {
    throw new KieApiError(
      "The server is missing KIE_AI_API_KEY. Set it as an environment variable on the host running this MCP server (get a key at https://kie.ai/api-key)."
    );
  }
  return key;
}

async function kieFetch(path: string, init: RequestInit = {}): Promise<any> {
  const url = `${KIE_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok) {
    throw new KieApiError(
      `Kie.ai API request to ${path} failed with HTTP ${res.status}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
      res.status,
      body
    );
  }

  // Kie.ai wraps successful responses as { code, msg, data }. A non-200
  // business `code` (e.g. 401/402/500) can still arrive with HTTP 200.
  if (body && typeof body === "object" && "code" in body && body.code !== 200 && body.code !== 0) {
    throw new KieApiError(`Kie.ai API error (code ${body.code}): ${body.msg || "unknown error"}`, res.status, body);
  }

  return body?.data ?? body;
}

// ---------------------------------------------------------------------------
// Generic Jobs API (works across most Kie.ai models: flux1-kontext,
// google/nano-banana, grok-imagine/text-to-image, etc.)
// ---------------------------------------------------------------------------

export interface CreateTaskParams {
  model: string;
  input: Record<string, unknown>;
  callBackUrl?: string;
}

export interface TaskRecord {
  taskId: string;
  model?: string;
  state: "waiting" | "queuing" | "generating" | "success" | "fail" | string;
  resultUrls: string[];
  failMsg?: string;
  progress?: number;
  raw: unknown;
}

export async function createTask(params: CreateTaskParams): Promise<{ taskId: string }> {
  const data = await kieFetch("/api/v1/jobs/createTask", {
    method: "POST",
    body: JSON.stringify(params)
  });
  const taskId = data?.taskId ?? data?.data?.taskId;
  if (!taskId) {
    throw new KieApiError(`Kie.ai did not return a taskId. Response: ${JSON.stringify(data)}`);
  }
  return { taskId };
}

export async function getTaskStatus(taskId: string): Promise<TaskRecord> {
  const data = await kieFetch(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
  let resultUrls: string[] = [];
  if (data?.resultJson) {
    try {
      const parsed = typeof data.resultJson === "string" ? JSON.parse(data.resultJson) : data.resultJson;
      resultUrls = parsed?.resultUrls ?? [];
    } catch {
      // leave resultUrls empty if resultJson isn't parseable JSON
    }
  }
  return {
    taskId: data?.taskId ?? taskId,
    model: data?.model,
    state: data?.state ?? "unknown",
    resultUrls,
    failMsg: data?.failMsg || undefined,
    progress: data?.progress,
    raw: data
  };
}

/** Poll a Jobs-API task until it succeeds, fails, or the timeout elapses. */
export async function waitForTask(taskId: string, maxWaitSeconds: number, pollIntervalMs = 4000): Promise<TaskRecord> {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let last: TaskRecord;
  do {
    last = await getTaskStatus(taskId);
    if (last.state === "success" || last.state === "fail") {
      return last;
    }
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  return last;
}

// ---------------------------------------------------------------------------
// Dedicated GPT-Image (gpt4o-image) API
// ---------------------------------------------------------------------------

export interface Gpt4oGenerateParams {
  prompt: string;
  size?: string;
  nVariants?: number;
  isEnhance?: boolean;
  callBackUrl?: string;
  filesUrl?: string[];
}

export interface Gpt4oTaskRecord {
  taskId: string;
  status: string;
  resultUrls: string[];
  raw: unknown;
}

export async function createGpt4oImageTask(params: Gpt4oGenerateParams): Promise<{ taskId: string }> {
  const data = await kieFetch("/api/v1/gpt4o-image/generate", {
    method: "POST",
    body: JSON.stringify(params)
  });
  const taskId = data?.taskId;
  if (!taskId) {
    throw new KieApiError(`Kie.ai did not return a taskId. Response: ${JSON.stringify(data)}`);
  }
  return { taskId };
}

export async function getGpt4oTaskStatus(taskId: string): Promise<Gpt4oTaskRecord> {
  const data = await kieFetch(`/api/v1/gpt4o-image/record-info?taskId=${encodeURIComponent(taskId)}`);
  return {
    taskId: data?.taskId ?? taskId,
    status: data?.status ?? "unknown",
    resultUrls: data?.response?.result_urls ?? data?.result_urls ?? [],
    raw: data
  };
}

export async function waitForGpt4oTask(
  taskId: string,
  maxWaitSeconds: number,
  pollIntervalMs = 5000
): Promise<Gpt4oTaskRecord> {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let last: Gpt4oTaskRecord;
  do {
    last = await getGpt4oTaskStatus(taskId);
    const terminal = ["SUCCESS", "CREATE_TASK_FAILED", "GENERATE_FAILED"];
    if (terminal.includes(last.status)) {
      return last;
    }
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
