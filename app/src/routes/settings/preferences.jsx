import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../../context/DashboardContext";
import { ConcurrencySection, ThemeSection } from "../../components/SettingsView";

export const Route = createFileRoute("/settings/preferences")({
  component: PreferenceSettings,
});

function PreferenceSettings() {
  const ctx = useDashboard();

  return (
    <div className="space-y-5">
      <ConcurrencySection
        concurrency={ctx.concurrency}
        setConcurrency={ctx.setConcurrency}
        saveConcurrency={ctx.saveConcurrency}
        savePending={ctx.saveConcPending}
      />
      <ThemeSection theme={ctx.theme} onThemeChange={ctx.setTheme} />
    </div>
  );
}
