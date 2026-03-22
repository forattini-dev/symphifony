import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../../context/DashboardContext";
import { ConnectionSection, PwaSection, SetupWizardSection } from "../../components/SettingsView";

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettings,
});

function GeneralSettings() {
  const ctx = useDashboard();

  return (
    <div className="space-y-5">
      <ConnectionSection status={ctx.status} wsStatus={ctx.wsStatus} />
      <PwaSection pwa={ctx.pwa} />
      <SetupWizardSection />
    </div>
  );
}
