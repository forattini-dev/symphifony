import { RefreshCw, WifiOff } from "lucide-react";

export function PwaBanner({ pwa }) {
  if (!pwa) return null;

  if (pwa.updateAvailable) {
    return (
      <div className="alert alert-info rounded-none border-x-0">
        <RefreshCw className="size-4" />
        <span className="text-sm">A fresh dashboard build is ready.</span>
        <button className="btn btn-sm btn-primary" onClick={() => pwa.applyUpdate()}>
          Reload app
        </button>
      </div>
    );
  }

  if (!pwa.isOnline) {
    return (
      <div className="alert alert-warning rounded-none border-x-0">
        <WifiOff className="size-4" />
        <span className="text-sm">You are offline. The app shell is available, but live runtime data may be stale.</span>
      </div>
    );
  }

  return null;
}

export default PwaBanner;
