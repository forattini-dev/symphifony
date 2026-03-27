import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../../hooks.js";
import { SettingsSection } from "../../components/SettingsSection.jsx";
import { RefreshCcw, Eye, RotateCcw, Check } from "lucide-react";

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
  const [playwrightReview, setPlaywrightReview] = useState(false);
  const [autoReplan, setAutoReplan] = useState(false);
  const [stallThreshold, setStallThreshold] = useState(2);

  // Saved indicators
  const [retriesSaved, setRetriesSaved] = useState(false);
  const [playwrightSaved, setPlaywrightSaved] = useState(false);
  const [replanSaved, setReplanSaved] = useState(false);
  const [stallSaved, setStallSaved] = useState(false);

  // ── Debounce timers ────────────────────────────────────────────────────────
  const retriesTimer = useRef(null);
  const playwrightTimer = useRef(null);
  const replanTimer = useRef(null);
  const stallTimer = useRef(null);

  // Current value refs
  const maxRetriesRef = useRef(2);
  const playwrightRef = useRef(false);
  const autoReplanRef = useRef(false);
  const stallRef = useRef(2);

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (hydrated || !settings?.length) return;
    const retries = getSettingValue(settings, "runtime.maxReviewAutoRetries", 2);
    const playwright = getSettingValue(settings, "runtime.enablePlaywrightReview", false);
    const replan = getSettingValue(settings, "runtime.autoReplanOnStall", false);
    const stall = getSettingValue(settings, "runtime.autoReplanStallThreshold", 2);
    setMaxRetries(retries ?? 2);
    setPlaywrightReview(playwright ?? false);
    setAutoReplan(replan ?? false);
    setStallThreshold(stall ?? 2);
    maxRetriesRef.current = retries ?? 2;
    playwrightRef.current = playwright ?? false;
    autoReplanRef.current = replan ?? false;
    stallRef.current = stall ?? 2;
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

  const handlePlaywrightChange = useCallback((val) => {
    setPlaywrightReview(val);
    playwrightRef.current = val;
    if (playwrightTimer.current) clearTimeout(playwrightTimer.current);
    playwrightTimer.current = setTimeout(async () => {
      try { await saveSetting("runtime.enablePlaywrightReview", playwrightRef.current); flash(setPlaywrightSaved); } catch {}
    }, 600);
  }, [saveSetting]);

  const handleAutoReplanChange = useCallback((val) => {
    setAutoReplan(val);
    autoReplanRef.current = val;
    if (replanTimer.current) clearTimeout(replanTimer.current);
    replanTimer.current = setTimeout(async () => {
      try { await saveSetting("runtime.autoReplanOnStall", autoReplanRef.current); flash(setReplanSaved); } catch {}
    }, 600);
  }, [saveSetting]);

  const handleStallChange = useCallback((val) => {
    setStallThreshold(val);
    stallRef.current = val;
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(async () => {
      try { await saveSetting("runtime.autoReplanStallThreshold", stallRef.current); flash(setStallSaved); } catch {}
    }, 600);
  }, [saveSetting]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    [retriesTimer, playwrightTimer, replanTimer, stallTimer].forEach((t) => {
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

      {/* Playwright Review */}
      <SettingsSection
        icon={Eye}
        title={<span className="flex items-center gap-2">Playwright review <SavedBadge show={playwrightSaved} /></span>}
        description="Gives the reviewer browser access to verify UI changes live. Requires a dev server running when issues with frontend changes are reviewed."
      >
        <label className="label cursor-pointer justify-start gap-3 p-0">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={playwrightReview}
            onChange={(e) => handlePlaywrightChange(e.target.checked)}
          />
          <span className="label-text text-sm">{playwrightReview ? "Enabled" : "Disabled"}</span>
        </label>
      </SettingsSection>

      {/* Auto-replan on stall */}
      <SettingsSection
        icon={RotateCcw}
        title={<span className="flex items-center gap-2">Auto-replan on stall <SavedBadge show={replanSaved} /></span>}
        description="When the same error type repeats N times during execution, automatically trigger a replan instead of retrying. Guarded to at most 4 replans total."
      >
        <label className="label cursor-pointer justify-start gap-3 p-0">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={autoReplan}
            onChange={(e) => handleAutoReplanChange(e.target.checked)}
          />
          <span className="label-text text-sm">{autoReplan ? "Enabled" : "Disabled"}</span>
        </label>
      </SettingsSection>

      {/* Stall threshold (only when auto-replan is on) */}
      {autoReplan && (
        <SettingsSection
          icon={null}
          title={<span className="flex items-center gap-2">Stall threshold <SavedBadge show={stallSaved} /></span>}
          description="How many consecutive same-error attempts trigger a replan."
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              className="range range-sm range-primary w-40"
              min={2}
              max={5}
              step={1}
              value={stallThreshold}
              onChange={(e) => handleStallChange(Number(e.target.value))}
            />
            <span className="text-sm font-mono w-4 text-center">{stallThreshold}</span>
          </div>
          <p className="text-xs opacity-40">
            A replan triggers after {stallThreshold} attempts with the same error type.
          </p>
        </SettingsSection>
      )}
    </div>
  );
}
