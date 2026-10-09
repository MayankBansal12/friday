import { useEffect, useState } from 'react';
import { LoaderCircle, VideoOff } from 'lucide-react';
import type { CameraView } from './useCameraLine';
import { useCameraLine } from './useCameraLine';

/** Live view of exactly what Friday's camera sees, mirrored like a video call self-view. */
export function CameraStage({ state, closable }: { state: CameraView; closable?: boolean }) {
  const [url, setUrl] = useState<string>();
  const camera = state?.camera;
  const on = Boolean(camera && camera !== 'off');
  const line = useCameraLine(state);
  const activity = state?.cameraActivity;
  const looking = camera === 'live' && (activity?.kind === 'looking' || activity?.kind === 'watching');
  useEffect(() => {
    if (!on) return;
    // Keep the previous frame's URL alive until the next one replaces it, so the <img> never flashes broken.
    const urls: string[] = [];
    const unsubscribe = window.buddy.onCameraFrame((jpeg) => {
      urls.push(URL.createObjectURL(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })));
      setUrl(urls.at(-1));
      while (urls.length > 2) URL.revokeObjectURL(urls.shift()!);
    });
    return () => {
      unsubscribe();
      urls.forEach((url) => URL.revokeObjectURL(url));
      setUrl(undefined);
    };
  }, [on]);
  if (!on) return null;
  return (
    <div
      className={`camera-stage ${looking ? 'is-looking' : ''}`}
      role="group"
      aria-label="Live camera preview"
      data-camera={camera}
    >
      {url && camera !== 'opening' ? (
        <img src={url} alt="What Friday's camera sees" />
      ) : (
        <span className="camera-stage-wait">
          <LoaderCircle className="spin" size={18} strokeWidth={1.5} />
          {camera === 'closing' ? 'Turning camera off…' : 'Starting camera…'}
        </span>
      )}
      <span className="camera-live">
        <i aria-hidden="true" />
        {camera === 'live' ? 'Live' : camera === 'opening' ? 'Starting' : 'Closing'}
      </span>
      {/* The header already announces camera narration; this chip is visual only. */}
      {camera === 'live' && (
        <span className={`camera-activity ${line ? '' : 'is-idle'}`} aria-hidden="true">
          {line ?? 'Friday only sees when it looks'}
        </span>
      )}
      {closable && camera === 'live' && (
        <button
          type="button"
          className="camera-off"
          aria-label="Turn camera off"
          title="Turn camera off"
          onClick={() => void window.buddy.setCamera(false)}
        >
          <VideoOff size={14} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
