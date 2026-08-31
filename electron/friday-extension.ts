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
  const timeout = AbortSignal.timeout(30_000);
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
    async execute(_id, params, signal, _update, ctx) {
      const confirmationReason = typeof params.confirmationReason === 'string' ? params.confirmationReason : '';
      if (confirmationReason) {
        const confirmed = await ctx.ui.confirm(
          'Friday identified a consequential desktop action',
          `${confirmationReason}\n\nApprove only if this description matches what you expect to happen.`,
        );
        if (!confirmed) return { content: [{ type: 'text', text: 'The user declined this action.' }], details: {} };
      }
      const result = await bridge('/action', params, signal);
      return {
        content: [{ type: 'text', text: String(result.message ?? 'Desktop action completed.') }],
        details: result,
      };
    },
  });
}
