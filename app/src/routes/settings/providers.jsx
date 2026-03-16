import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../../context/DashboardContext";
import ProvidersView from "../../components/ProvidersView";

export const Route = createFileRoute("/settings/providers")({
  component: ProviderSettings,
});

function ProviderSettings() {
  const ctx = useDashboard();
  return <ProvidersView providersUsage={ctx.providersUsage} />;
}
