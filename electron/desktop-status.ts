export interface DesktopStatus {
  ready: boolean;
  error?: string;
  annotations?: number;
  marking?: boolean;
  protocolVersion?: number;
}

export const desktopUpdateMessage =
  'Friday’s screen integration has been updated. Save your work, sign out of GNOME, then sign back in to activate the drawing fixes.';

export function desktopErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/org\.freedesktop\.DBus\.Error\.(ServiceUnknown|NameHasNoOwner)/.test(message)) {
    return 'Screen access is not ready. Save your work, sign out of GNOME, then sign back in and reopen Friday. You can still chat here.';
  }
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export class DesktopError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function desktopInterruption(error: unknown) {
  const code = error instanceof DesktopError ? error.code : undefined;
  const reasons: Record<string, string> = {
    escape: 'Stopped with Escape.',
    user_stop: 'Desktop control was stopped.',
    overview: 'Screen control stopped because the GNOME overview opened. Return to your app and try again.',
    locked: 'Screen control stopped because the desktop was locked. Unlock it and try again.',
    monitors_changed: 'Screen control stopped because the display configuration changed.',
    disconnected: 'The desktop connection closed. Reopen Friday and try again.',
    extension_disabled: 'The desktop extension was disabled. Re-enable it and try again.',
    lease_expired: 'The desktop connection timed out. Please try again.',
  };
  return {
    user: code === 'escape' || code === 'user_stop',
    source: code === 'escape' ? ('escape' as const) : ('user' as const),
    message: (code && reasons[code]) || `Screen control was interrupted: ${desktopErrorMessage(error)}`,
  };
}
