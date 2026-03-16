import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../../context/DashboardContext";
import {
  ThemeSection,
  ConcurrencySection,
  ConnectionSection,
  PwaSection,
  SetupWizardSection,
} from "../../components/SettingsView";

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettings,
});

function GeneralSettings() {
  const ctx = useDashboard();
  return (
    <div className="space-y-5">
      <ConnectionSection status={ctx.status} wsStatus={ctx.wsStatus} />
      <ThemeSection theme={ctx.theme} onThemeChange={ctx.setTheme} />
      <ConcurrencySection
        concurrency={ctx.concurrency}
        setConcurrency={ctx.setConcurrency}
        saveConcurrency={ctx.saveConcurrency}
        savePending={ctx.saveConcPending}
      />
      <PwaSection pwa={ctx.pwa} />
      <SetupWizardSection />
    </div>
  );
}
