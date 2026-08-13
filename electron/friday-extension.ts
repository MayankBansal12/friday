type ToolEvent = { toolName: string; input: Record<string, unknown> };
type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details: unknown;
};
type ExtensionContext = { ui: { confirm(title: string, message: string): Promise<boolean> } };
type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((result: ToolResult) => void) | undefined,
    context: ExtensionContext,
  ): Promise<ToolResult>;
};
type ExtensionAPI = {
  on(
    event: 'tool_call',
    handler: (event: ToolEvent, context: ExtensionContext) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
  registerTool(definition: ToolDefinition): void;
};

const dangerPatterns = [
  /\b(?:sudo|su|pkexec)\b/i,
  /\brm\s+(?:-[^\n]*r|--recursive)/i,
  /\b(?:mkfs|fdisk|parted|dd)\b/i,
  /\b(?:shutdown|reboot|poweroff)\b/i,
  /\b(?:curl|wget)\b[^\n]*(?:-d|--data|--upload-file|-T)\b/i,
  /\bgit\s+(?:push|reset\s+--hard|clean\s+-f)/i,
  /\b(?:chmod|chown)\b/i,
  /\b(?:apt|dnf|pacman|npm|pnpm|pip)\s+(?:install|remove|uninstall|publish)/i,
];

export function isConsequentialCommand(command: string) {
  return dangerPatterns.some((pattern) => pattern.test(command));
}

function bridgeUrl(path: string) {
  const origin = process.env.LINUX_BUDDY_BRIDGE_URL;
  const token = process.env.LINUX_BUDDY_BRIDGE_TOKEN;
  if (!origin || !token) throw new Error('Friday desktop bridge is unavailable');
  return { url: `${origin}${path}`, token };
}

async function bridge(path: string, body?: unknown) {
  const { url, token } = bridgeUrl(path);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Record<string, unknown>>;
}

export default function fridayExtension(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    const command = String(event.input.command ?? '');
    if (!dangerPatterns.some((pattern) => pattern.test(command))) return undefined;
    const confirmed = await ctx.ui.confirm('Allow consequential command?', command);
    return confirmed ? undefined : { block: true, reason: 'The user did not approve this command.' };
  });

  pi.registerTool({
    name: 'desktop_observe',
    label: 'Look at screen',
    description:
      'Capture the current desktop. Use this before and after GUI actions to understand visible applications.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const result = await bridge('/screenshot');
      return {
        content: [
          { type: 'text', text: `Current desktop (${result.width}×${result.height})` },
          { type: 'image', data: String(result.data), mimeType: 'image/png' },
        ],
        details: { width: result.width, height: result.height },
      };
    },
  });

  pi.registerTool({
    name: 'desktop_action',
    label: 'Control desktop',
    description:
      'Control the visible Linux desktop by clicking coordinates, typing text, pressing keys, scrolling, or opening an app/URL. Observe first. Set confirmationReason for deletion, privilege changes, purchases, sending messages, publishing, or sensitive-data disclosure.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'open'] },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        amount: { type: 'number' },
        target: { type: 'string' },
        confirmationReason: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _update, ctx) {
      const confirmationReason = typeof params.confirmationReason === 'string' ? params.confirmationReason : '';
      if (confirmationReason) {
        const confirmed = await ctx.ui.confirm('Friday needs your approval', confirmationReason);
        if (!confirmed) return { content: [{ type: 'text', text: 'The user declined this action.' }], details: {} };
      }
      const result = await bridge('/action', params);
      return {
        content: [{ type: 'text', text: String(result.message ?? 'Desktop action completed.') }],
        details: result,
      };
    },
  });
}
