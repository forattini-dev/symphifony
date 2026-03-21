import { useRef, useEffect, useCallback, useState } from "react";
import {
  Bell, X, CheckCheck, Play, Clock, Eye,
  CheckCircle, AlertTriangle, XCircle, Zap,
} from "lucide-react";
import { timeAgo } from "../utils.js";

const STATE_ICONS = {
  Running: Play,
  Queued: Clock,
  Reviewing: Eye,
  PendingDecision: Eye,
  Approved: CheckCircle,
  Blocked: AlertTriangle,
  Cancelled: XCircle,
  "token-milestone": Zap,
};

const STATE_COLORS = {
  Running: "text-info",
  Queued: "text-warning",
  Reviewing: "text-accent",
  PendingDecision: "text-success",
  Approved: "text-success",
  Blocked: "text-error",
  Cancelled: "text-base-content/40",
  "token-milestone": "text-secondary",
};

const STATE_BG = {
  Running: "bg-info/8",
  Queued: "bg-warning/8",
  Reviewing: "bg-accent/8",
  PendingDecision: "bg-success/8",
  Approved: "bg-success/8",
  Blocked: "bg-error/8",
  Cancelled: "bg-base-200",
  "token-milestone": "bg-secondary/8",
};

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e) => setMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return mobile;
}

function NotificationItem({ notif, onDismiss }) {
  const Icon = STATE_ICONS[notif.state] || Bell;
  const color = STATE_COLORS[notif.state] || "text-base-content";
  const bg = notif.read ? "" : (STATE_BG[notif.state] || "");

  // Split identifier from title if present (e.g. "Agent started: #4" → "#4" + "Agent started")
  const identifierMatch = notif.title?.match(/(.*?):\s*(#\S+|[A-Z]+-\d+)$/);
  const displayTitle = identifierMatch ? identifierMatch[1] : notif.title;
  const identifier = identifierMatch ? identifierMatch[2] : null;

  return (
    <li
      className={`group relative px-3 py-2.5 transition-colors
        ${notif.read ? "opacity-50" : ""}
        ${bg}
        hover:bg-base-200/60`}
      role="menuitem"
    >
      <div className="flex items-start gap-2.5">
        {/* Icon with state-colored dot */}
        <span className={`mt-0.5 shrink-0 ${color}`}>
          <Icon className="size-4" />
        </span>

        <div className="flex-1 min-w-0">
          {/* Title row with identifier */}
          <div className="flex items-baseline gap-1.5">
            {identifier && (
              <span className="font-mono text-[11px] font-semibold opacity-70 shrink-0">{identifier}</span>
            )}
            <p className="text-xs font-medium leading-snug line-clamp-2">{displayTitle}</p>
          </div>

          {notif.body && (
            <p className="text-xs opacity-50 leading-snug mt-0.5 line-clamp-1">{notif.body}</p>
          )}

          <p className="text-[10px] opacity-30 mt-1">{timeAgo(notif.timestamp)}</p>
        </div>

        {/* Unread dot */}
        {!notif.read && (
          <span className={`size-1.5 rounded-full shrink-0 mt-1.5 ${color.replace("text-", "bg-")}`} />
        )}
      </div>

      {/* Dismiss — visible on hover/focus only */}
      <button
        className="absolute top-1.5 right-1.5 btn btn-ghost btn-xs btn-circle
          opacity-0 group-hover:opacity-60 group-focus-within:opacity-60
          hover:!opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(notif.id);
        }}
        aria-label="Dismiss notification"
      >
        <X className="size-3" />
      </button>
    </li>
  );
}

function NotificationList({ notifications, onDismiss }) {
  if (notifications.length === 0) {
    return (
      <div className="py-10 text-center">
        <Bell className="size-8 mx-auto opacity-10 mb-2" />
        <p className="text-sm opacity-40">No notifications yet</p>
        <p className="text-xs opacity-25 mt-0.5">State changes and milestones will appear here</p>
      </div>
    );
  }

  return (
    <div className="max-h-80 overflow-y-auto overscroll-contain max-md:max-h-[60vh]">
      <ul>
        {notifications.map((notif, i) => (
          <NotificationItem
            key={notif.id}
            notif={notif}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
    </div>
  );
}

function NotificationHeader({ count, onMarkAllRead, onClose }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-base-300">
      <span className="text-sm font-semibold">Notifications</span>
      <div className="flex items-center gap-2">
        {count > 0 && (
          <button
            className="btn btn-ghost btn-xs gap-1"
            onClick={onMarkAllRead}
            aria-label="Mark all as read"
          >
            <CheckCheck className="size-3" />
            Mark all read
          </button>
        )}
        {onClose && (
          <button
            className="btn btn-ghost btn-xs btn-circle"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function MobileBottomSheet({ open, onClose, notifications, onDismiss, onMarkAllRead }) {
  const [closing, setClosing] = useState(false);
  const touchStartY = useRef(null);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
    }, 250);
  }, [onClose]);

  const onTouchStart = useCallback((e) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const onTouchEnd = useCallback((e) => {
    if (touchStartY.current === null) return;
    const delta = e.changedTouches[0].clientY - touchStartY.current;
    if (delta > 80) handleClose();
    touchStartY.current = null;
  }, [handleClose]);

  if (!open && !closing) return null;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 z-50
          ${closing ? "animate-toast-out" : "animate-fade-in"}`}
        onClick={handleClose}
      />
      <div
        className={`fixed bottom-0 left-0 right-0 z-50
          bg-base-100 rounded-t-2xl shadow-2xl
          ${closing ? "animate-slide-down-sheet" : "animate-slide-up-sheet"}`}
        style={{ maxHeight: "70vh", paddingBottom: "env(safe-area-inset-bottom)" }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-base-content/20" />
        </div>

        <NotificationHeader
          count={notifications.length}
          onMarkAllRead={onMarkAllRead}
          onClose={handleClose}
        />

        <NotificationList
          notifications={notifications}
          onDismiss={onDismiss}
        />
      </div>
    </>
  );
}

export function NotificationCenter({
  notifications,
  unreadCount,
  onDismiss,
  onMarkAllRead,
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const isMobile = useIsMobile();

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    if (!open || isMobile) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, isMobile]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className="btn btn-ghost btn-sm btn-circle relative"
        onClick={toggle}
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : "Notifications"
        }
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <span className="badge badge-xs badge-primary absolute -top-0.5 -right-0.5 animate-count-bump">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {isMobile && (
        <MobileBottomSheet
          open={open}
          onClose={() => setOpen(false)}
          notifications={notifications}
          onDismiss={onDismiss}
          onMarkAllRead={onMarkAllRead}
        />
      )}

      {!isMobile && open && (
        <div
          className="absolute right-0 top-full mt-2 w-80
            max-w-[calc(100vw-2rem)] bg-base-100 rounded-box
            shadow-xl border border-base-300 z-50 animate-fade-in-scale"
          role="menu"
          aria-label="Notification center"
        >
          <NotificationHeader
            count={notifications.length}
            onMarkAllRead={onMarkAllRead}
          />
          <NotificationList
            notifications={notifications}
            onDismiss={onDismiss}
          />
        </div>
      )}
    </div>
  );
}

export default NotificationCenter;
