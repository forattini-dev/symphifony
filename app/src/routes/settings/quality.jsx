import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../../hooks.js";
import { SettingsSection } from "../../components/SettingsSection.jsx";
import { RefreshCcw, Check } from "lucide-react";

export const Route = createFileRoute("/settings/quality")({
  beforeLoad: () => { throw redirect({ to: "/settings/execution" }); },
});

export function QualitySettingsPanel() {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const settings = getSettingsList(settingsQuery.data);
  const [hydrated, setHydrated] = useState(false);

  // ── State ──────────────────────────────────────────────────────────────────
  const [maxRetries, setMaxRetries] = useState(2);

  // Saved indicators
  const [retriesSaved, setRetriesSaved] = useState(false);

  // ── Debounce timers ────────────────────────────────────────────────────────
  const retriesTimer = useRef(null);

  // Current value refs
  const maxRetriesRef = useRef(2);

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (hydrated || !settings?.length) return;
    const retries = getSettingValue(settings, "runtime.maxReviewAutoRetries", 2);
    setMaxRetries(retries ?? 2);
    maxRetriesRef.current = retries ?? 2;
    setHydrated(true);
  }, [settings, hydrated]);

  // ── Save helper ────────────────────────────────────────────────────────────
  const saveSetting = useCallback(async (id, value) => {
    await api.post(`/settings/${encodeURIComponent(id)}`, { scope: "runtime", value, source: "user" });
    qc.setQueryData(SETTINGS_QUERY_KEY, (current) =>
      upsertSettingPayload(current, { id, scope: "runtime", value, source: "user", updatedAt: new Date().toISOString() })
    );
  }, [qc]);

  const flash = (setter) => { setter(true); setTimeout(() => setter(false), 1500); };

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleRetriesChange = useCallback((val) => {
    setMaxRetries(val);
    maxRetriesRef.current = val;
    if (retriesTimer.current) clearTimeout(retriesTimer.current);
    retriesTimer.current = setTimeout(async () => {
      try { await saveSetting("runtime.maxReviewAutoRetries", maxRetriesRef.current); flash(setRetriesSaved); } catch {}
    }, 600);
  }, [saveSetting]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    [retriesTimer].forEach((t) => {
      if (t.current) clearTimeout(t.current);
    });
  }, []);

  const SavedBadge = ({ show }) =>
    show ? (
      <span className="text-xs text-success flex items-center gap-1 animate-fade-in">
        <Check className="size-3" /> saved
      </span>
    ) : null;

  return (
    <div className="space-y-4">

      {/* Max Review Retries */}
      <SettingsSection
        icon={RefreshCcw}
        title={<span className="flex items-center gap-2">Max review retries <SavedBadge show={retriesSaved} /></span>}
        description="How many times the reviewer can automatically request rework before escalating to you. Set to 0 to always ask."
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            className="range range-sm range-primary w-40"
            min={0}
            max={5}
            step={1}
            value={maxRetries}
            onChange={(e) => handleRetriesChange(Number(e.target.value))}
          />
          <span className="text-sm font-mono w-4 text-center">{maxRetries}</span>
        </div>
        <p className="text-xs opacity-40">
          {maxRetries === 0
            ? "Every review result goes directly to Pending Decision."
            : `Up to ${maxRetries} automatic rework cycle${maxRetries > 1 ? "s" : ""} before escalating to you.`}
        </p>
      </SettingsSection>
    </div>
  );
}
