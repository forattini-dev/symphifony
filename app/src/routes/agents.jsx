import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../context/DashboardContext";
import RuntimeView from "../components/RuntimeView";

export const Route = createFileRoute("/agents")({
  component: RuntimePage,
});

function RuntimePage() {
  const ctx = useDashboard();
  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4 overflow-y-auto">
      <RuntimeView
        state={ctx.data}
        providers={ctx.providers.data || {}}
        parallelism={ctx.parallelism.data || {}}
        onRefresh={ctx.refresh}
        issues={ctx.issues}
      />
    </div>
  );
}
