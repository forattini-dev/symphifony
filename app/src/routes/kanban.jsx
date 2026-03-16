import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../context/DashboardContext";
import BoardView from "../components/BoardView";
import StatsBar from "../components/StatsBar";

export const Route = createFileRoute("/kanban")({
  component: KanbanPage,
});

function KanbanPage() {
  const ctx = useDashboard();
  return (
    <div className="flex-1 flex flex-col min-h-0 px-3 pb-2 gap-2">
      <StatsBar metrics={ctx.metrics} total={ctx.issues.length} issues={ctx.issues} compact />
      <BoardView
        issues={ctx.filtered}
        onStateChange={ctx.updateState}
        onRetry={ctx.retryIssue}
        onCancel={ctx.cancelIssue}
        onSelect={ctx.setSelectedIssue}
      />
    </div>
  );
}
