import React from "react";
import { Inbox } from "lucide-react";

export function EmptyState({ icon: Icon = Inbox, title = "Nothing here", description = "", action, actionLabel = "Action" }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 opacity-60 animate-fade-in-up">
      <Icon className="size-12 mb-4 opacity-40" />
      <h3 className="text-base font-semibold mb-1">{title}</h3>
      {description && (
        <p className="text-sm opacity-70 text-center max-w-xs">{description}</p>
      )}
      {action && (
        <button className="btn btn-sm btn-primary mt-4" onClick={action}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export default EmptyState;
