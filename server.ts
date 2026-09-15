import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response, NextFunction } from "express";
import * as z from "zod/v4";
import {
  createTask,
  getTaskStatus,
  waitForTask,
  createGpt4oImageTask,
  getGpt4oTaskStatus,
  waitForGpt4oTask,
  KieApiError
} from "./kieClient.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
// Comma-separated list of hostnames Claude will actually send as the Host
// header (your deployed domain, e.g. "kie-mcp.onrender.com"). Required once
// you're not on localhost, otherwise the SDK's DNS-rebinding guard rejects
// every request. Leave unset only for local testing.
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(",").map(h => h.trim()).filter(Boolean);
// Shared secret this server expects on every request, as either
//   Authorization: Bearer <secret>
// or
//   X-MCP-Secret: <secret>
// Set this in Claude's custom connector config (static header auth) so
// nobody else who finds your server's URL can spend your Kie.ai credits.
// If left unset, the server accepts unauthenticated requests (fine only for
// quick local testing).
const SHARED_SECRET = process.env.MCP_SHARED_SECRET;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  const message = err instanceof KieApiError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function formatTaskRecord(record: { taskId: string; state: string; resultUrls: string[]; failMsg?: string; progress?: number }) {
  const lines = [`taskId: ${record.taskId}`, `state: ${record.state}`];
  if (record.progress !== undefined) lines.push(`progress: ${record.progress}`);
  if (record.failMsg) lines.push(`failMsg: ${record.failMsg}`);
  if (record.resultUrls.length) {
    lines.push("resultUrls:");
    for (const url of record.resultUrls) lines.push(`  - ${url}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP server: tool definitions
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer({ name: "kie-ai-image-connector", version: "1.0.0" }, { capabilities: {} });

  // ---- Generic Jobs API: works for most Kie.ai models -------------------

  server.registerTool(
    "kie_create_task",
    {
      title: "Create a Kie.ai generation task",
      description:
        "Starts an async image/video generation task on Kie.ai for ANY model in their catalog (e.g. 'flux1-kontext', " +
        "'google/nano-banana', 'grok-imagine/text-to-image', midjourney models, etc.). Use this when you know the " +
        "exact model slug and its input fields from https://docs.kie.ai — for the common case of a plain text-to-image " +
        "or image-edit banner, prefer 'kie_generate_image' instead, which wraps this with sensible defaults and polling. " +
        "Returns immediately with a taskId; use 'kie_get_task_status' to check on it.",
      inputSchema: {
        model: z.string().describe("Kie.ai model slug, e.g. 'flux1-kontext' or 'google/nano-banana'"),
        input: z
          .record(z.string(), z.unknown())
          .describe(
            "Model-specific input object, e.g. { prompt: '...', aspect_ratio: '16:9' }. Field names vary by model — check docs.kie.ai."
          ),
        callBackUrl: z.string().url().optional().describe("Optional webhook Kie.ai will POST the result to when done.")
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ model, input, callBackUrl }) => {
      try {
        const { taskId } = await createTask({ model, input: input as Record<string, unknown>, callBackUrl });
        return textResult(`Task created.\ntaskId: ${taskId}\n\nCheck progress with kie_get_task_status.`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "kie_get_task_status",
    {
      title: "Get Kie.ai task status",
      description:
        "Checks the status of a task created with 'kie_create_task' or 'kie_generate_image'. Returns state " +
        "(waiting/queuing/generating/success/fail) and, once successful, the resulting image/video URL(s).",
      inputSchema: {
        taskId: z.string().describe("The taskId returned when the task was created.")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ taskId }) => {
      try {
        const record = await getTaskStatus(taskId);
        return textResult(formatTaskRecord(record));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "kie_generate_image",
    {
      title: "Generate a banner/ad image with Kie.ai",
      description:
        "Convenience tool for the everyday case: generate (or edit) an image with a Kie.ai model through the generic " +
        "Jobs API, and by default wait for the result instead of making you poll separately. Good default model for " +
        "banners/ads is 'flux1-kontext' (supports both text-to-image and image editing via inputImageUrl). " +
        "For OpenAI's GPT-Image model specifically, use 'kie_generate_image_gpt4o' instead.",
      inputSchema: {
        model: z.string().default("flux1-kontext").describe("Kie.ai model slug. Defaults to 'flux1-kontext'."),
        prompt: z.string().describe("What to generate or how to edit the reference image."),
        aspectRatio: z
          .string()
          .optional()
          .describe("e.g. '1:1', '16:9', '9:16', '3:2'. Omit to use the model's default."),
        inputImageUrl: z
          .string()
          .url()
          .optional()
          .describe("Public URL of a reference image to edit, for models that support image editing."),
        outputFormat: z.enum(["png", "jpeg"]).optional().describe("Defaults to the model's own default."),
        extraInput: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Any additional model-specific input fields to merge in, for advanced use."),
        waitForResult: z.boolean().default(true).describe("If true, poll until done and return the image URL(s) directly."),
        maxWaitSeconds: z.number().int().min(10).max(280).default(120).describe("Max seconds to wait when waitForResult is true.")
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ model, prompt, aspectRatio, inputImageUrl, outputFormat, extraInput, waitForResult, maxWaitSeconds }) => {
      try {
        const input: Record<string, unknown> = { prompt, ...extraInput };
        if (aspectRatio) input.aspect_ratio = aspectRatio;
        if (inputImageUrl) input.inputImage = inputImageUrl;
        if (outputFormat) input.output_format = outputFormat;

        const { taskId } = await createTask({ model, input });

        if (!waitForResult) {
          return textResult(`Task created.\ntaskId: ${taskId}\n\nCheck progress with kie_get_task_status.`);
        }

        const record = await waitForTask(taskId, maxWaitSeconds);
        if (record.state !== "success" && record.state !== "fail") {
          return textResult(
            `${formatTaskRecord(record)}\n\nStill not finished after ${maxWaitSeconds}s — call kie_get_task_status with this taskId later.`
          );
        }
        return textResult(formatTaskRecord(record));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ---- Dedicated GPT-Image (gpt4o-image) API -----------------------------

  server.registerTool(
    "kie_generate_image_gpt4o",
    {
      title: "Generate an image with GPT-Image (via Kie.ai)",
      description:
        "Generates an image using OpenAI's GPT-Image model through Kie.ai's dedicated endpoint (separate from the " +
        "generic Jobs API). Good for photorealistic or text-heavy banner/ad creatives. Waits for the result by default.",
      inputSchema: {
        prompt: z.string().describe("Description of the image to generate."),
        size: z
          .enum(["1:1", "2:3", "3:2"])
          .default("1:1")
          .describe("Output aspect ratio."),
        nVariants: z.number().int().min(1).max(4).default(1).describe("How many variants to generate."),
        isEnhance: z.boolean().default(false).describe("Whether to let Kie.ai enhance/rewrite the prompt."),
        referenceImageUrls: z
          .array(z.string().url())
          .max(5)
          .optional()
          .describe("Optional public URLs of reference images (for edits/variations)."),
        waitForResult: z.boolean().default(true),
        maxWaitSeconds: z.number().int().min(10).max(280).default(150)
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ prompt, size, nVariants, isEnhance, referenceImageUrls, waitForResult, maxWaitSeconds }) => {
      try {
        const { taskId } = await createGpt4oImageTask({
          prompt,
          size,
          nVariants,
          isEnhance,
          filesUrl: referenceImageUrls
        });

        if (!waitForResult) {
          return textResult(`Task created.\ntaskId: ${taskId}\n\nCheck progress with kie_get_gpt4o_task_status.`);
        }

        const record = await waitForGpt4oTask(taskId, maxWaitSeconds);
        const lines = [`taskId: ${record.taskId}`, `status: ${record.status}`];
        if (record.resultUrls.length) {
          lines.push("resultUrls:");
          for (const url of record.resultUrls) lines.push(`  - ${url}`);
        } else {
          lines.push(`Still not finished after ${maxWaitSeconds}s — call kie_get_gpt4o_task_status with this taskId later.`);
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "kie_get_gpt4o_task_status",
    {
      title: "Get GPT-Image task status",
      description: "Checks the status of a task created with 'kie_generate_image_gpt4o'.",
      inputSchema: { taskId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ taskId }) => {
      try {
        const record = await getGpt4oTaskStatus(taskId);
        const lines = [`taskId: ${record.taskId}`, `status: ${record.status}`];
        if (record.resultUrls.length) {
          lines.push("resultUrls:");
          for (const url of record.resultUrls) lines.push(`  - ${url}`);
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app: auth + the stateless /mcp endpoint
// ---------------------------------------------------------------------------

const app = createMcpExpressApp(ALLOWED_HOSTS ? { host: "0.0.0.0", allowedHosts: ALLOWED_HOSTS } : { host: "0.0.0.0" });

if (!ALLOWED_HOSTS) {
  // eslint-disable-next-line no-console
  console.warn(
    "ALLOWED_HOSTS is not set — Host-header DNS-rebinding protection is OFF. " +
      "Set ALLOWED_HOSTS to your deployed domain (e.g. 'kie-mcp.onrender.com') once you have it."
  );
}

function checkAuth(req: Request, res: Response, next: NextFunction) {
  if (!SHARED_SECRET) {
    next();
    return;
  }
  const authHeader = req.header("authorization");
  const secretHeader = req.header("x-mcp-secret");
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer === SHARED_SECRET || secretHeader === SHARED_SECRET) {
    next();
    return;
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid credential." },
    id: null
  });
}

app.get("/", (_req, res) => {
  res.send("Kie.ai MCP connector is running. Point Claude's custom connector at POST /mcp.");
});

app.post("/mcp", checkAuth, async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", checkAuth, (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.delete("/mcp", checkAuth, (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Kie.ai MCP connector listening on port ${PORT}`);
});
