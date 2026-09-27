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

const dangerPatterns: Array<[RegExp, string]> = [
  [/\b(?:sudo|su|doas|pkexec)\b/i, 'This command requests elevated privileges.'],
  [
    /\b(?:(?:[\w./-]+\/)?(?:rm|rmdir|unlink|shred))\b|\bfind\b[^\n;&|]{0,500}\s-delete\b/i,
    'This command can delete files.',
  ],
  [
    /\b(?:mkfs(?:\.\w+)?|fdisk|parted|wipefs|cryptsetup)\b|\bdd\b[^\n;&|]*\bof=/i,
    'This command can overwrite disks or filesystems.',
  ],
  [
    /\b(?:shutdown|reboot|poweroff|halt)\b|\bsystemctl\b[^\n;&|]*\b(?:stop|disable|mask|reboot|poweroff)\b/i,
    'This command can stop services or the computer.',
  ],
  [
    /\b(?:curl|wget)\b[^\n;&|]*(?:\s(?:-d|-F|-T)\b|--data\b|--form\b|--upload-file\b)|\b(?:scp|sftp)\b/i,
    'This command may send local data over the network.',
  ],
  [
    /\bgit\b[^\n;&|]{0,300}\bpush\b|\bgit\b[^\n;&|]{0,300}\breset\b[^\n;&|]*--hard\b|\bgit\b[^\n;&|]{0,300}\bclean\b[^\n;&|]*-[a-z]*f/i,
    'This command can publish or irreversibly discard repository work.',
  ],
  [/\b(?:chmod|chown|chgrp|setfacl)\b/i, 'This command changes file permissions or ownership.'],
  [
    /\b(?:apt(?:-get)?|dnf|yum|pacman|zypper|snap|flatpak)\b[^\n;&|]{0,300}\b(?:install|remove|purge|uninstall)\b/i,
    'This command changes installed system software.',
  ],
  [
    /\b(?:npm|pnpm|yarn|pip|pipx|gem|cargo)\b[^\n;&|]{0,300}\b(?:publish|install|uninstall|remove)\b/i,
    'This command installs, removes, or publishes packages.',
  ],
  [
    /\b(?:gh\s+(?:release|pr\s+merge)|mail|mailx|sendmail)\b/i,
    'This command may publish or send something externally.',
  ],
];

export function consequentialCommandReason(command: string) {
  const normalized = command.replace(/\\\r?\n/g, ' ').replace(/[\0\r]/g, ' ');
  return dangerPatterns.find(([pattern]) => pattern.test(normalized))?.[1];
}

export function isConsequentialCommand(command: string) {
  return Boolean(consequentialCommandReason(command));
}

function bridgeUrl(path: string) {
  const origin = process.env.LINUX_BUDDY_BRIDGE_URL;
  const token = process.env.LINUX_BUDDY_BRIDGE_TOKEN;
  if (!origin || !token) throw new Error('Friday desktop bridge is unavailable');
  return { url: `${origin}${path}`, token };
}

async function bridge(path: string, body?: unknown, signal?: AbortSignal) {
  const { url, token } = bridgeUrl(path);
  const timeout = AbortSignal.timeout(90_000);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Record<string, unknown>>;
}

export default function fridayExtension(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (
      process.env.LINUX_BUDDY_MODE !== 'act' &&
      ['bash', 'powershell', 'write', 'edit', 'read', 'grep', 'find', 'ls', 'desktop_action'].includes(event.toolName)
    )
      return { block: true, reason: 'This tool requires Act mode, selected by the user in Friday.' };
    if (event.toolName !== 'bash') return undefined;
    const command = String(event.input.command ?? '');
    const reason = consequentialCommandReason(command);
    if (!reason) return undefined;
    const confirmed = await ctx.ui.confirm(
      'Potentially consequential shell command',
      `${reason}\n\n${command.slice(0, 3000)}`,
    );
    return confirmed ? undefined : { block: true, reason: 'The user did not approve this command.' };
  });

  pi.registerTool({
    name: 'desktop_observe',
    label: 'Look at screen',
    description:
      'Capture the current desktop. Use this before and after GUI actions to understand visible applications.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _params, signal) {
      const result = await bridge('/screenshot', undefined, signal);
      const mark = result.lastMark as Record<string, unknown> | null;
      return {
        content: [
          {
            type: 'text',
            text: `Current desktop screenshot: ${result.width} pixels wide × ${result.height} pixels high. All drawing and input coordinates refer to THIS image, with (0,0) at its top-left. Locate the target's actual edges within the image before choosing its bounding box. Metadata: ${JSON.stringify({ observationId: result.id, displayId: (result.display as { id: string }).id, windowTitle: result.windowTitle, windowBounds: result.windowBounds, lastMark: mark ? { points: mark.points, current: mark.current, createdAt: mark.createdAt } : null, capturedAt: result.capturedAt })}`,
          },
          { type: 'image', data: String(result.data), mimeType: String(result.mimeType || 'image/png') },
        ],
        details: { ...result, data: undefined },
      };
    },
  });

  pi.registerTool({
    name: 'desktop_draw',
    label: 'Annotate the screen',
    description:
      'Draw click-through arrows, ellipses, rectangles, highlights, labels, or paths over the observed app. Use screenshot pixels and the latest observation/display IDs. For an ellipse, x/y are the TOP-LEFT of its bounding box, never its center; width/height are full diameters. For example, a button bounded by left=100, top=200, right=400, bottom=280 is circled with x=100,y=200,width=300,height=80. Reuse an item ID to update it with replace=false. Annotations expire after 30 seconds or when the scene changes. No mouse input is injected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        observationId: { type: 'string' },
        displayId: { type: 'string' },
        replace: { type: 'boolean' },
        items: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              kind: { type: 'string', enum: ['arrow', 'ellipse', 'rectangle', 'highlight', 'label', 'path'] },
              x: {
                type: 'number',
                description:
                  'Left edge of ellipse/rectangle/highlight bounding box, or arrow start / label origin. Screenshot pixels; not the ellipse center.',
              },
              y: {
                type: 'number',
                description:
                  'Top edge of ellipse/rectangle/highlight bounding box, or arrow start / label origin. Screenshot pixels; not the ellipse center.',
              },
              width: {
                type: 'number',
                description:
                  'Full bounding-box width in screenshot pixels; for an ellipse this is its horizontal diameter, not radius.',
              },
              height: {
                type: 'number',
                description:
                  'Full bounding-box height in screenshot pixels; for an ellipse this is its vertical diameter, not radius.',
              },
              toX: { type: 'number', description: 'Arrow tip X in screenshot pixels.' },
              toY: { type: 'number', description: 'Arrow tip Y in screenshot pixels.' },
              text: { type: 'string' },
              color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Hex RGB, for example #70e3cd' },
              points: {
                type: 'array',
                maxItems: 512,
                items: {
                  type: 'object',
                  properties: { x: { type: 'number' }, y: { type: 'number' } },
                  required: ['x', 'y'],
                  additionalProperties: false,
                },
              },
            },
            required: ['id', 'kind', 'x', 'y'],
          },
        },
      },
      required: ['observationId', 'displayId', 'items'],
    },
    async execute(_id, params, signal) {
      const result = await bridge('/draw', params, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: 'desktop_clear',
    label: 'Clear annotations',
    description: 'Clear all annotations, or only the listed IDs.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
    async execute(_id, params, signal) {
      const result = await bridge('/clear', params, signal);
      return { content: [{ type: 'text', text: 'Annotations cleared.' }], details: result };
    },
  });
  pi.registerTool({
    name: 'desktop_action',
    label: 'Control desktop',
    description:
      'Perform one desktop action. The host requests consent; the user may explicitly grant up to five clicks/scrolls in the same window for 60 seconds. Set forceConfirmation=true for consequential actions (send, publish, delete, purchase, or disclose data), which always require fresh confirmation. Observe first and use its IDs. Observe again after the action to verify. Explain the purpose before calling this tool. Do not chain unverified actions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'key', 'scroll'] },
        observationId: { type: 'string' },
        displayId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        amount: { type: 'number' },
        forceConfirmation: {
          type: 'boolean',
          description:
            'Required true for consequential effects; bypasses any bounded navigation permission and asks again.',
        },
      },
      required: ['action', 'observationId', 'displayId'],
    },
    async execute(_id, params, signal) {
      const result = await bridge('/action', params, signal);
      return { content: [{ type: 'text', text: String(result.message) }], details: result };
    },
  });
}
