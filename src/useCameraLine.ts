import { useEffect, useState } from 'react';
import { cameraActivityLine, cameraLookedMs, type FridayState } from '../electron/types';

export type CameraView = Pick<FridayState, 'camera' | 'cameraActivity'> | undefined;

/** The camera narration line, re-rendered when "Looked at you" expires. */
export function useCameraLine(state: CameraView) {
  const [now, setNow] = useState(() => Date.now());
  const activity = state?.cameraActivity;
  useEffect(() => {
    if (activity?.kind !== 'looked') return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, activity.at + cameraLookedMs - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [activity]);
  // A new activity is always current; only the expiry needs the timer above.
  return cameraActivityLine(state, Math.max(now, activity?.kind === 'looked' ? activity.at : 0));
}
