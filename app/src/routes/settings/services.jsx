import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect } from "react";
import { api } from "../../api.js";
import { useServices } from "../../hooks/useServices.js";
import { useVariables, getVariablesList, useVariableMutations, VARIABLES_QUERY_KEY } from "../../hooks/useVariables.js";
import { useDashboard } from "../../context/DashboardContext.jsx";
import { SettingsSection } from "../../components/SettingsSection.jsx";
import {
  Globe, Server, Play, Square, Loader2, Plus, Trash2, Pencil, Check, X, Sparkles, Circle,
  Network, Terminal, Heart, ChevronDown, FolderOpen, ShieldCheck, ExternalLink, Info,
} from "lucide-react";

export const Route = createFileRoute("/settings/services")({
  component: ServicesSettings,
});

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Variable row editor ────────────────────────────────────────────────────────

function VariableRow({ variable, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState(variable.key);
  const [draftValue, setDraftValue] = useState(variable.value);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!draftKey.trim() || !ENV_KEY_PATTERN.test(draftKey.trim())) return;
    setBusy(true);
    try {
      await onUpdate(variable.key, draftKey.trim(), draftValue, variable.scope);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try { await onDelete(variable.id); } finally { setBusy(false); }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-1.5">
        <input
          className="input input-xs input-bordered font-mono w-36"
          value={draftKey}
          onChange={(e) => setDraftKey(e.target.value)}
          placeholder="KEY"
        />
        <span className="text-xs opacity-30">=</span>
        <input
          className="input input-xs input-bordered font-mono flex-1 min-w-0"
          value={draftValue}
          onChange={(e) => setDraftValue(e.target.value)}
          placeholder="value"
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }}
        />
        <button className="btn btn-xs btn-success btn-square" onClick={handleSave} disabled={busy}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
        </button>
        <button className="btn btn-xs btn-ghost btn-square" onClick={() => setEditing(false)}>
          <X className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 py-1.5 group">
      <span className="font-mono text-xs text-primary w-36 truncate">{variable.key}</span>
      <span className="text-xs opacity-30">=</span>
      <span className="font-mono text-xs flex-1 min-w-0 truncate opacity-70">{variable.value || <span className="opacity-30 italic">empty</span>}</span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button className="btn btn-xs btn-ghost btn-square" onClick={() => setEditing(true)} title="Edit">
          <Pencil className="size-3" />
        </button>
        <button className="btn btn-xs btn-ghost btn-square text-error" onClick={handleDelete} disabled={busy} title="Delete">
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
        </button>
      </div>
    </div>
  );
}

// ── Add variable row ───────────────────────────────────────────────────────────

function AddVariableRow({ scope, onAdd }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    const trimKey = key.trim();
    if (!trimKey) { setError("Key is required."); return; }
    if (!ENV_KEY_PATTERN.test(trimKey)) { setError(`Invalid key "${trimKey}".`); return; }
    setError("");
    setBusy(true);
    try {
      await onAdd(trimKey, value, scope);
      setKey("");
      setValue("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-xs btn-ghost gap-1 opacity-50 hover:opacity-100" onClick={() => setOpen(true)}>
        <Plus className="size-3" /> Add variable
      </button>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          className="input input-xs input-bordered font-mono w-36"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="KEY"
        />
        <span className="text-xs opacity-30">=</span>
        <input
          className="input input-xs input-bordered font-mono flex-1 min-w-0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") { setOpen(false); setKey(""); setValue(""); } }}
        />
        <button className="btn btn-xs btn-primary btn-square" onClick={handleSave} disabled={busy}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
        </button>
        <button className="btn btn-xs btn-ghost btn-square" onClick={() => { setOpen(false); setKey(""); setValue(""); setError(""); }}>
          <X className="size-3" />
        </button>
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

// ── Variables list section ─────────────────────────────────────────────────────

function VariablesList({ scope, variables, onUpdate, onDelete, onAdd }) {
  const scoped = variables.filter((v) => v.scope === scope);

  return (
    <div className="space-y-0.5">
      {scoped.length === 0 && (
        <p className="text-xs opacity-30 py-1">No variables set.</p>
      )}
      {scoped.map((v) => (
        <VariableRow
          key={v.id}
          variable={v}
          onDelete={onDelete}
          onUpdate={onUpdate}
        />
      ))}
      <div className="pt-1">
        <AddVariableRow scope={scope} onAdd={onAdd} />
      </div>
    </div>
  );
}

// ── Detected service card ──────────────────────────────────────────────────────

function DetectedServiceCard({ suggestion, onSelect }) {
  return (
    <button
      className="flex items-start gap-3 p-3 rounded-lg border border-primary/20 bg-base-100/50 hover:bg-primary/5 hover:border-primary/40 transition-colors text-left w-full cursor-pointer"
      onClick={() => onSelect(suggestion)}
    >
      <Plus className="size-3.5 text-primary shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold truncate">{suggestion.label}</p>
        <p className="font-mono text-[11px] opacity-50 truncate">{suggestion.command}</p>
        {suggestion.cwd && (
          <p className="text-[11px] opacity-30 flex items-center gap-1 mt-0.5">
            <FolderOpen className="size-2.5" /> {suggestion.cwd}
          </p>
        )}
      </div>
    </button>
  );
}

// ── Service config card ────────────────────────────────────────────────────────

const SERVICE_STATUS_DOT = {
  running:  "text-success fill-success",
  starting: "text-warning fill-warning",
  stopping: "text-warning fill-warning",
  crashed:  "text-error fill-error",
  stopped:  "text-base-content/20 fill-base-content/20",
};
const LOCAL_DOMAIN_PORT_SUFFIX = /:\d+$/;

function normalizeLocalDomain(host = "") {
  const trimmed = host.trim();
  if (!trimmed) return "";
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostOnly = withoutScheme.split("/")[0]?.split("?")[0] ?? "";
  return hostOnly.replace(LOCAL_DOMAIN_PORT_SUFFIX, "").toLowerCase();
}

/** Display: array → "a, b, c" | string → as-is | undefined → "" */
function hostToDisplay(host) {
  if (!host) return "";
  return Array.isArray(host) ? host.join(", ") : host;
}
/** Parse: "a, b, c" → ["a","b","c"] | single → "single" | empty → undefined */
function parseHostInput(raw) {
  if (!raw || !raw.trim()) return undefined;
  const parts = raw.split(",").map((h) => h.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : parts;
}

function formatHttpsOrigin(host, port) {
  if (!host) return "";
  const normalizedPort = Number(port ?? 443);
  return normalizedPort === 443
    ? `https://${host}`
    : `https://${host}:${normalizedPort}`;
}

function ServiceConfigCard({ service, variables, onSave, onDelete, onAssignPort, onVariableUpdate, onVariableDelete, onVariableAdd, proxyRoutes = [], onProxyRoutesChange }) {
  const [editing, setEditing] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: service.name,
    command: service.command,
    cwd: service.cwd || "",
    port: service.port ?? "",
    stopCommand: service.stopCommand || "",
    autoStart: !!service.autoStart,
    autoRestart: !!service.autoRestart,
    maxCrashes: service.maxCrashes ?? 5,
  });
  const [busy, setBusy] = useState(false);

  const state = service.state ?? (service.running ? "running" : "stopped");
  const dotColor = SERVICE_STATUS_DOT[state] ?? "text-base-content/20 fill-base-content/20";
  const serviceVars = variables.filter((v) => v.scope === service.id);
  const serviceRoutes = proxyRoutes.filter((r) => r.serviceId === service.id);

  useEffect(() => {
    if (!editing) {
      setDraft({
        name: service.name,
        command: service.command,
        cwd: service.cwd || "",
        port: service.port ?? "",
        stopCommand: service.stopCommand || "",
        autoStart: !!service.autoStart,
        autoRestart: !!service.autoRestart,
        maxCrashes: service.maxCrashes ?? 5,
      });
    }
  }, [service, editing]);

  const handleSave = async () => {
    if (!draft.name.trim() || !draft.command.trim()) return;
    setBusy(true);
    try {
      const port = draft.port === "" ? undefined : Number(draft.port);
      await onSave({
        ...service,
        ...draft,
        name: draft.name.trim(),
        command: draft.command.trim(),
        cwd: draft.cwd.trim() || undefined,
        port: (port && !isNaN(port)) ? port : undefined,
        stopCommand: draft.stopCommand.trim() || undefined,
        maxCrashes: draft.autoRestart ? draft.maxCrashes : undefined,
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Remove service "${service.name}"?`)) return;
    await onDelete(service.id);
  };

  const handleAssignPort = async () => {
    setBusy(true);
    try {
      await onAssignPort?.(service);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card bg-base-200">
      <div className="card-body p-4 gap-2">
        {/* Header row */}
        <div className="flex items-center gap-3">
          <Circle className={`size-2.5 shrink-0 ${dotColor}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{service.name}</span>
              {service.port && (
                <span className="badge badge-xs badge-outline font-mono gap-1">
                  <Network className="size-2.5" />:{service.port}
                </span>
              )}
              {service.healthcheck && (
                <span className="badge badge-xs badge-outline badge-success gap-1">
                  <Heart className="size-2.5" /> healthcheck
                </span>
              )}
              {!service.port && (
                <span className="badge badge-xs badge-warning badge-outline gap-1">
                  <Info className="size-2.5" /> no port
                </span>
              )}
            </div>
            <div className="font-mono text-xs opacity-40 truncate mt-0.5">{service.command}</div>
            {service.cwd && <span className="text-[11px] opacity-25 font-mono">{service.cwd}</span>}
            {service.stopCommand && (
              <p className="text-[11px] opacity-25 mt-0.5">stops with: <span className="font-mono">{service.stopCommand}</span></p>
            )}
            {!service.port && (
              <p className="text-[11px] opacity-40 mt-1">
                Fifony can assign a free port above <span className="font-mono">12000</span> and use it for <span className="font-mono">PORT</span> and reverse-proxy routing.
              </p>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {!service.port && (
              <button
                className="btn btn-xs btn-ghost gap-1 text-warning opacity-70 hover:opacity-100"
                onClick={handleAssignPort}
                disabled={busy}
                title="Assign a managed port"
              >
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Network className="size-3" />}
                Assign port
              </button>
            )}
            <button
              className={`btn btn-xs btn-ghost gap-1 ${varsOpen ? "text-primary" : "opacity-50 hover:opacity-100"}`}
              onClick={() => setVarsOpen((v) => !v)}
            >
              Variables{serviceVars.length > 0 && <span className="badge badge-xs badge-primary">{serviceVars.length}</span>}
            </button>
            <button
              className={`btn btn-xs btn-ghost gap-1 ${routesOpen ? "text-primary" : "opacity-50 hover:opacity-100"}`}
              onClick={() => setRoutesOpen((v) => !v)}
            >
              Routes{serviceRoutes.length > 0 && <span className="badge badge-xs badge-primary">{serviceRoutes.length}</span>}
            </button>
            <button
              className={`btn btn-xs btn-ghost ${editing ? "text-primary" : "opacity-50 hover:opacity-100"}`}
              onClick={() => setEditing((v) => !v)}
              title="Edit service"
            >
              <Pencil className="size-3" />
            </button>
            <button
              className="btn btn-xs btn-ghost text-error opacity-50 hover:opacity-100"
              onClick={handleDelete}
              title="Delete service"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        </div>

        {/* Per-service variables */}
        {varsOpen && (
          <div className="pl-5 border-l border-base-content/10 ml-1">
            <p className="text-xs opacity-40 mb-1.5">These override global variables for this service. Changes take effect on the next restart.</p>
            <VariablesList
              scope={service.id}
              variables={variables}
              onUpdate={onVariableUpdate}
              onDelete={onVariableDelete}
              onAdd={onVariableAdd}
            />
          </div>
        )}

        {/* Per-service proxy routes */}
        {routesOpen && (
          <div className="pl-5 border-l border-base-content/10 ml-1 space-y-2">
            <p className="text-xs opacity-40">Proxy routes that forward to this service via the HTTPS reverse proxy.</p>
            {serviceRoutes.length > 0 && (
              <div>
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2 pb-1">
                  <span className="text-[10px] opacity-30 uppercase tracking-wider">Host</span>
                  <span className="text-[10px] opacity-30 uppercase tracking-wider">Path prefix</span>
                  <span />
                </div>
                {serviceRoutes.map((route) => {
                  const globalIdx = proxyRoutes.findIndex((r) => r.id === route.id);
                  return (
                    <div key={route.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center py-1.5 border-b border-base-content/5 last:border-0">
                      <input
                        className="input input-xs input-bordered font-mono"
                        value={hostToDisplay(route.host)}
                        onChange={(e) => {
                          const updated = { ...route, host: parseHostInput(e.target.value) };
                          const next = proxyRoutes.map((r, i) => i === globalIdx ? updated : r);
                          onProxyRoutesChange?.(next);
                        }}
                        placeholder="app.myproject.local"
                        title="Comma-separate for multiple hosts"
                      />
                      <div className="flex items-center gap-1">
                        <input
                          className="input input-xs input-bordered font-mono flex-1 min-w-0"
                          value={route.pathPrefix ?? ""}
                          onChange={(e) => {
                            const updated = { ...route, pathPrefix: e.target.value || undefined };
                            const next = proxyRoutes.map((r, i) => i === globalIdx ? updated : r);
                            onProxyRoutesChange?.(next);
                          }}
                          placeholder="/api"
                        />
                        {route.pathPrefix && (
                          <label className="label cursor-pointer gap-1 p-0 shrink-0" title="Strip prefix before forwarding">
                            <input
                              type="checkbox"
                              className="checkbox checkbox-xs checkbox-primary"
                              checked={route.stripPrefix !== false}
                              onChange={(e) => {
                                const updated = { ...route, stripPrefix: e.target.checked };
                                const next = proxyRoutes.map((r, i) => i === globalIdx ? updated : r);
                                onProxyRoutesChange?.(next);
                              }}
                            />
                            <span className="label-text text-[10px] opacity-50">strip</span>
                          </label>
                        )}
                      </div>
                      <button
                        className="btn btn-xs btn-ghost btn-square text-error opacity-40 hover:opacity-100"
                        onClick={() => onProxyRoutesChange?.(proxyRoutes.filter((r) => r.id !== route.id))}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <button
              className="btn btn-xs btn-ghost gap-1 opacity-50 hover:opacity-100"
              onClick={() => onProxyRoutesChange?.([...proxyRoutes, { id: `route-${Date.now()}`, serviceId: service.id }])}
            >
              <Plus className="size-3" /> Add route
            </button>
          </div>
        )}

        {/* Edit form */}
        {editing && (
          <div className="pl-5 border-l border-base-content/10 ml-1 space-y-3 pt-1">
            {/* Basic */}
            <fieldset className="space-y-2">
              <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Basic</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="form-control">
                  <div className="label py-0.5"><span className="label-text text-xs">Name *</span></div>
                  <input className="input input-bordered input-sm" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                </label>
                <label className="form-control">
                  <div className="label py-0.5"><span className="label-text text-xs">Command *</span></div>
                  <input className="input input-bordered input-sm font-mono text-xs" value={draft.command} onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))} placeholder="pnpm dev" />
                </label>
              </div>
            </fieldset>

            {/* Paths */}
            <fieldset className="space-y-2">
              <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Paths</legend>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-2">
                <label className="form-control">
                  <div className="label py-0.5"><span className="label-text text-xs">Working directory</span></div>
                  <input className="input input-bordered input-sm font-mono text-xs" value={draft.cwd} onChange={(e) => setDraft((d) => ({ ...d, cwd: e.target.value }))} placeholder="(project root)" />
                </label>
                <label className="form-control">
                  <div className="label py-0.5"><span className="label-text text-xs">Port</span></div>
                  <input
                    type="number"
                    className="input input-bordered input-sm font-mono text-xs"
                    value={draft.port}
                    onChange={(e) => setDraft((d) => ({ ...d, port: e.target.value }))}
                    placeholder="3000"
                    min={1}
                    max={65535}
                  />
                  <div className="label py-0.5">
                    <span className="label-text-alt text-[11px] opacity-40">If empty, Fifony assigns a free port above 12000 and injects it as <span className="font-mono">PORT</span>.</span>
                  </div>
                </label>
              </div>
            </fieldset>

            {/* Stop command */}
            <fieldset className="space-y-2">
              <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Stop</legend>
              <label className="form-control">
                <div className="label py-0.5"><span className="label-text text-xs">Stop command</span></div>
                <input className="input input-bordered input-sm font-mono text-xs" value={draft.stopCommand} onChange={(e) => setDraft((d) => ({ ...d, stopCommand: e.target.value }))} placeholder="docker compose down" />
                <div className="label py-0.5"><span className="label-text-alt text-[11px] opacity-40">Custom shutdown command. If empty, kills the process.</span></div>
              </label>
            </fieldset>

            {/* Behavior */}
            <fieldset className="space-y-2">
              <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Behavior</legend>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <label className="label cursor-pointer justify-start gap-2 p-0">
                  <input type="checkbox" className="checkbox checkbox-sm checkbox-primary" checked={draft.autoStart} onChange={(e) => setDraft((d) => ({ ...d, autoStart: e.target.checked }))} />
                  <span className="label-text text-xs">Auto-start on boot</span>
                </label>
                <label className="label cursor-pointer justify-start gap-2 p-0">
                  <input type="checkbox" className="checkbox checkbox-sm checkbox-primary" checked={draft.autoRestart} onChange={(e) => setDraft((d) => ({ ...d, autoRestart: e.target.checked }))} />
                  <span className="label-text text-xs">Auto-restart on crash</span>
                </label>
                {draft.autoRestart && (
                  <label className="flex items-center gap-2 p-0">
                    <span className="label-text text-xs opacity-60">Max crashes:</span>
                    <input
                      type="number"
                      className="input input-bordered input-xs w-16 font-mono"
                      min={1} max={10}
                      value={draft.maxCrashes}
                      onChange={(e) => setDraft((d) => ({ ...d, maxCrashes: Math.min(10, Math.max(1, Number(e.target.value) || 1)) }))}
                    />
                  </label>
                )}
              </div>
            </fieldset>

            <div className="flex gap-2 pt-1">
              <button className="btn btn-xs btn-primary gap-1" onClick={handleSave} disabled={busy}>
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Save
              </button>
              <button className="btn btn-xs btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add service card ───────────────────────────────────────────────────────────

function AddServiceForm({ onAdd, onCancel }) {
  const [draft, setDraft] = useState({ name: "", command: "", cwd: "", port: "", stopCommand: "", autoStart: false, autoRestart: false, maxCrashes: 5 });
  const [detecting, setDetecting] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [busy, setBusy] = useState(false);

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const res = await api.get("/services/detect");
      setSuggestions(res?.suggestions ?? []);
    } finally {
      setDetecting(false);
    }
  };

  const handleSuggestion = (sug) => {
    setDraft((d) => ({ ...d, name: sug.label, command: sug.command, cwd: sug.cwd || "", port: sug.port ?? "" }));
    setSuggestions([]);
  };

  const handleSave = async () => {
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!name || !command) return;
    const slug = command.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
    const id = `${slug}-${Date.now()}`;
    const port = draft.port === "" ? undefined : Number(draft.port);
    setBusy(true);
    try {
      await onAdd({
        id,
        name,
        command,
        cwd: draft.cwd.trim() || undefined,
        port: (port && !isNaN(port)) ? port : undefined,
        stopCommand: draft.stopCommand.trim() || undefined,
        autoStart: draft.autoStart,
        autoRestart: draft.autoRestart,
        maxCrashes: draft.autoRestart ? draft.maxCrashes : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card bg-base-200 border border-primary/20">
      <div className="card-body p-4 gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold opacity-60 uppercase tracking-wider">New service</span>
          <button className="btn btn-xs btn-ghost gap-1 opacity-60 hover:opacity-100" onClick={handleDetect} disabled={detecting}>
            {detecting ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
            Detect
          </button>
        </div>

        {suggestions.length > 0 && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5 space-y-2">
            <span className="text-xs opacity-60">Detected services — click to fill the form:</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {suggestions.map((s, i) => (
                <DetectedServiceCard key={i} suggestion={s} onSelect={handleSuggestion} />
              ))}
            </div>
            <button className="text-xs opacity-40 hover:opacity-70" onClick={() => setSuggestions([])}>dismiss</button>
          </div>
        )}

        {/* Basic */}
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Basic</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="form-control">
              <div className="label py-0.5"><span className="label-text text-xs">Name *</span></div>
              <input className="input input-bordered input-sm" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="API server" />
            </label>
            <label className="form-control">
              <div className="label py-0.5"><span className="label-text text-xs">Command *</span></div>
              <input className="input input-bordered input-sm font-mono text-xs" value={draft.command} onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))} placeholder="pnpm dev" />
            </label>
          </div>
        </fieldset>

        {/* Paths */}
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Paths</legend>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-2">
            <label className="form-control">
              <div className="label py-0.5"><span className="label-text text-xs">Working directory</span></div>
              <input className="input input-bordered input-sm font-mono text-xs" value={draft.cwd} onChange={(e) => setDraft((d) => ({ ...d, cwd: e.target.value }))} placeholder="(project root)" />
            </label>
            <label className="form-control">
              <div className="label py-0.5"><span className="label-text text-xs">Port</span></div>
              <input
                type="number"
                className="input input-bordered input-sm font-mono text-xs"
                value={draft.port}
                onChange={(e) => setDraft((d) => ({ ...d, port: e.target.value }))}
                placeholder="3000"
                min={1}
                max={65535}
              />
              <div className="label py-0.5">
                <span className="label-text-alt text-[11px] opacity-40">If empty, Fifony assigns a free port above 12000 and injects it as <span className="font-mono">PORT</span>.</span>
              </div>
            </label>
          </div>
        </fieldset>

        {/* Stop command */}
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Stop</legend>
          <label className="form-control">
            <div className="label py-0.5"><span className="label-text text-xs">Stop command</span></div>
            <input className="input input-bordered input-sm font-mono text-xs" value={draft.stopCommand} onChange={(e) => setDraft((d) => ({ ...d, stopCommand: e.target.value }))} placeholder="docker compose down" />
            <div className="label py-0.5"><span className="label-text-alt text-[11px] opacity-40">Custom shutdown command. If empty, kills the process.</span></div>
          </label>
        </fieldset>

        {/* Behavior */}
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Behavior</legend>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="label cursor-pointer justify-start gap-2 p-0">
              <input type="checkbox" className="checkbox checkbox-sm checkbox-primary" checked={draft.autoStart} onChange={(e) => setDraft((d) => ({ ...d, autoStart: e.target.checked }))} />
              <span className="label-text text-xs">Auto-start on boot</span>
            </label>
            <label className="label cursor-pointer justify-start gap-2 p-0">
              <input type="checkbox" className="checkbox checkbox-sm checkbox-primary" checked={draft.autoRestart} onChange={(e) => setDraft((d) => ({ ...d, autoRestart: e.target.checked }))} />
              <span className="label-text text-xs">Auto-restart on crash</span>
            </label>
            {draft.autoRestart && (
              <label className="flex items-center gap-2 p-0">
                <span className="label-text text-xs opacity-60">Max crashes:</span>
                <input
                  type="number"
                  className="input input-bordered input-xs w-16 font-mono"
                  min={1} max={10}
                  value={draft.maxCrashes}
                  onChange={(e) => setDraft((d) => ({ ...d, maxCrashes: Math.min(10, Math.max(1, Number(e.target.value) || 1)) }))}
                />
              </label>
            )}
          </div>
        </fieldset>

        <div className="flex gap-2">
          <button className="btn btn-xs btn-primary gap-1" onClick={handleSave} disabled={busy || !draft.name.trim() || !draft.command.trim()}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} Add
          </button>
          <button className="btn btn-xs btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Empty state with detect CTA ──────────────────────────────────────────────

function EmptyServicesState({ onAdd, onDetect, detecting }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <Server className="size-8 opacity-20" />
      <p className="text-xs opacity-40 text-center">No services configured yet.</p>
      <div className="flex items-center gap-2">
        <button className="btn btn-sm btn-primary gap-1.5" onClick={onDetect} disabled={detecting}>
          {detecting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          Detect services
        </button>
        <button className="btn btn-sm btn-ghost gap-1.5 opacity-60 hover:opacity-100" onClick={onAdd}>
          <Plus className="size-3.5" /> Add manually
        </button>
      </div>
    </div>
  );
}

// ── Proxy route row ───────────────────────────────────────────────────────────

function ProxyRouteRow({ route, services, onChange, onDelete, localDomain }) {
  const [useService, setUseService] = useState(Boolean(route.serviceId));

  useEffect(() => {
    setUseService(Boolean(route.serviceId));
  }, [route.serviceId]);

  const update = (patch) => onChange({ ...route, ...patch });
  const hostPlaceholder = localDomain ? `app.${localDomain}` : "app.myproject.local";
  const selectedService = services.find((service) => service.id === route.serviceId);

  return (
    <div className="grid grid-cols-[1fr_1fr_1.5fr_auto] gap-2 items-start py-1.5 border-b border-base-content/5 last:border-0">
      {/* Host — comma-separated for multiple */}
      <input
        className="input input-xs input-bordered font-mono"
        value={hostToDisplay(route.host)}
        onChange={(e) => update({ host: parseHostInput(e.target.value) })}
        placeholder={hostPlaceholder}
        title="Comma-separate for multiple hosts: app.myproject.local, www.myproject.local"
      />

      {/* Path prefix */}
      <div className="flex items-center gap-1">
        <input
          className="input input-xs input-bordered font-mono flex-1 min-w-0"
          value={route.pathPrefix ?? ""}
          onChange={(e) => update({ pathPrefix: e.target.value || undefined })}
          placeholder="/login"
        />
        {route.pathPrefix && (
          <label className="label cursor-pointer gap-1 p-0 shrink-0" title="Strip prefix before forwarding">
            <input
              type="checkbox"
              className="checkbox checkbox-xs checkbox-primary"
              checked={route.stripPrefix !== false}
              onChange={(e) => update({ stripPrefix: e.target.checked })}
            />
            <span className="label-text text-[10px] opacity-50">strip</span>
          </label>
        )}
      </div>

      {/* Target */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn btn-xs btn-ghost font-mono opacity-50 hover:opacity-100 shrink-0"
          onClick={() => {
            if (useService) {
              setUseService(false);
              update({ serviceId: undefined, target: "" });
              return;
            }
            setUseService(true);
            update({ serviceId: undefined, target: undefined });
          }}
          title={useService ? "Switch to custom URL" : "Switch to service"}
        >
          {useService ? "svc" : "url"}
        </button>
        {useService ? (
          <div className="flex-1 min-w-0">
            <select
              className="select select-xs select-bordered w-full font-mono text-[11px]"
              value={route.serviceId ?? ""}
              onChange={(e) => update({ serviceId: e.target.value || undefined, target: undefined })}
            >
              <option value="">— pick service —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.port}>
                  {s.name}{s.port ? ` :${s.port}` : " (missing port)"}
                </option>
              ))}
            </select>
            {selectedService && !selectedService.port && (
              <p className="text-[10px] text-warning mt-1">This service needs a configured port before the proxy can route to it.</p>
            )}
          </div>
        ) : (
          <input
            className="input input-xs input-bordered font-mono flex-1 min-w-0"
            value={route.target ?? ""}
            onChange={(e) => update({ target: e.target.value || undefined, serviceId: undefined })}
            placeholder="http://127.0.0.1:3000"
          />
        )}
      </div>

      {/* Delete */}
      <button className="btn btn-xs btn-ghost btn-square text-error opacity-40 hover:opacity-100" onClick={onDelete}>
        <Trash2 className="size-3" />
      </button>
    </div>
  );
}

// ── Network runtime section ───────────────────────────────────────────────────

function ReverseProxySection({ services, proxyRoutes, onRoutesChange }) {
  const [status, setStatus] = useState(null);
  const [meshStatus, setMeshStatus] = useState(null);
  const [meshOpen, setMeshOpen] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(true);
  const [portDraft, setPortDraft] = useState("");
  const [domainDraft, setDomainDraft] = useState("");
  const [meshPortDraft, setMeshPortDraft] = useState("");
  const [meshBufferDraft, setMeshBufferDraft] = useState("");
  const [meshWindowDraft, setMeshWindowDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [portSaved, setPortSaved] = useState(false);
  const [domainSaved, setDomainSaved] = useState(false);
  const [meshPortSaved, setMeshPortSaved] = useState(false);
  const [meshBufferSaved, setMeshBufferSaved] = useState(false);
  const [meshWindowSaved, setMeshWindowSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get("/proxy/reverse/status"),
      api.get("/mesh/status"),
      api.get(`/settings/${encodeURIComponent("runtime.meshBufferSize")}`).catch(() => null),
      api.get(`/settings/${encodeURIComponent("runtime.meshLiveWindowSeconds")}`).catch(() => null),
    ]).then(([reverseRes, meshRes, meshBufferRes, meshWindowRes]) => {
      if (reverseRes) {
        setStatus(reverseRes);
        setPortDraft(String(reverseRes.port ?? 4433));
        setDomainDraft(reverseRes.localDomain ?? "");
      }
      if (meshRes) {
        setMeshStatus(meshRes);
        setMeshPortDraft(String(meshRes.port ?? ""));
      }
      setMeshBufferDraft(String(meshBufferRes?.value ?? 1000));
      setMeshWindowDraft(String(meshWindowRes?.value ?? 900));
      setError("");
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load network runtime status.");
    });
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const [reverseRes, meshRes, meshBufferRes, meshWindowRes] = await Promise.all([
        api.get("/proxy/reverse/status"),
        api.get("/mesh/status"),
        api.get(`/settings/${encodeURIComponent("runtime.meshBufferSize")}`).catch(() => null),
        api.get(`/settings/${encodeURIComponent("runtime.meshLiveWindowSeconds")}`).catch(() => null),
      ]);
      if (reverseRes) {
        setStatus(reverseRes);
        setPortDraft(String(reverseRes.port ?? 4433));
        setDomainDraft(reverseRes.localDomain ?? "");
      }
      if (meshRes) {
        setMeshStatus(meshRes);
        setMeshPortDraft(String(meshRes.port ?? ""));
      }
      setMeshBufferDraft(String(meshBufferRes?.value ?? (meshBufferDraft || 1000)));
      setMeshWindowDraft(String(meshWindowRes?.value ?? (meshWindowDraft || 900)));
      setError("");
      return { reverseRes, meshRes };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh network runtime status.");
      return null;
    }
  }, [meshBufferDraft, meshWindowDraft]);

  const handleMeshToggle = async (enabled) => {
    setBusy(true);
    try {
      const res = await api.post("/mesh/toggle", { enabled });
      setMeshStatus((prev) => ({ ...prev, enabled, running: res.running, port: res.port }));
      setError("");
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${enabled ? "start" : "stop"} service mesh.`);
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (enabled) => {
    setBusy(true);
    try {
      if (enabled) {
        const draftPort = parseInt(portDraft, 10);
        const portValid = draftPort >= 1 && draftPort <= 65535;
        const portChanged = portValid && draftPort !== status?.port;
        if (portChanged) {
          await api.post(`/settings/${encodeURIComponent("runtime.reverseProxyPort")}`, { value: draftPort, scope: "runtime", source: "user" });
        }
        // If already running, restart so the new port takes effect
        if (status?.running) {
          await api.post("/services/reverse-proxy/restart", {});
          await refreshStatus();
          return;
        }
      }
      const res = await api.post("/proxy/reverse/toggle", { enabled });
      setStatus((prev) => ({ ...prev, enabled, running: res.running, port: res.port }));
      setError("");
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${enabled ? "start" : "stop"} reverse proxy.`);
    } finally {
      setBusy(false);
    }
  };

  const handlePortSave = async () => {
    const p = parseInt(portDraft, 10);
    if (!p || p < 1 || p > 65535) return;
    setBusy(true);
    try {
      await api.post(`/settings/${encodeURIComponent("runtime.reverseProxyPort")}`, { value: p, scope: "runtime", source: "user" });
      const wasRunning = status?.running;
      setStatus((prev) => ({ ...prev, port: p }));
      if (wasRunning) {
        await api.post("/services/reverse-proxy/restart", {});
      }
      setError("");
      await refreshStatus();
      setPortSaved(true);
      setTimeout(() => setPortSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save reverse proxy port.");
    } finally {
      setBusy(false);
    }
  };

  const handleDomainSave = async () => {
    const d = domainDraft.trim();
    setBusy(true);
    try {
      await api.put("/proxy/reverse/domain", { localDomain: d });
      setStatus((prev) => ({ ...prev, localDomain: d }));
      setError("");
      await refreshStatus();
      setDomainSaved(true);
      setTimeout(() => setDomainSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save reverse proxy domain.");
    } finally {
      setBusy(false);
    }
  };

  const handleMeshPortSave = async () => {
    const p = parseInt(meshPortDraft, 10);
    if (Number.isNaN(p) || p < 0 || p > 65535) return;
    setBusy(true);
    try {
      await api.post(`/settings/${encodeURIComponent("runtime.meshProxyPort")}`, { value: p, scope: "runtime", source: "user" });
      const wasEnabled = meshStatus?.enabled === true;
      if (wasEnabled) {
        await api.post("/mesh/toggle", { enabled: true });
      }
      setError("");
      await refreshStatus();
      setMeshPortSaved(true);
      setTimeout(() => setMeshPortSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save mesh port.");
    } finally {
      setBusy(false);
    }
  };

  const handleMeshBufferSave = async () => {
    const size = parseInt(meshBufferDraft, 10);
    if (!size || size < 100 || size > 100000) return;
    setBusy(true);
    try {
      await api.post(`/settings/${encodeURIComponent("runtime.meshBufferSize")}`, { value: size, scope: "runtime", source: "user" });
      const wasEnabled = meshStatus?.enabled === true;
      if (wasEnabled) {
        await api.post("/mesh/toggle", { enabled: true });
      }
      setError("");
      await refreshStatus();
      setMeshBufferSaved(true);
      setTimeout(() => setMeshBufferSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save mesh buffer.");
    } finally {
      setBusy(false);
    }
  };

  const handleMeshWindowSave = async () => {
    const seconds = parseInt(meshWindowDraft, 10);
    if (!seconds || seconds < 30 || seconds > 86400) return;
    setBusy(true);
    try {
      await api.post(`/settings/${encodeURIComponent("runtime.meshLiveWindowSeconds")}`, { value: seconds, scope: "runtime", source: "user" });
      const wasEnabled = meshStatus?.enabled === true;
      if (wasEnabled) {
        await api.post("/mesh/toggle", { enabled: true });
      }
      setError("");
      await refreshStatus();
      setMeshWindowSaved(true);
      setTimeout(() => setMeshWindowSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save mesh live window.");
    } finally {
      setBusy(false);
    }
  };

  const handleRouteChange = (idx, updated) => {
    onRoutesChange(proxyRoutes.map((r, i) => i === idx ? updated : r));
  };

  const handleRouteDelete = (idx) => {
    onRoutesChange(proxyRoutes.filter((_, i) => i !== idx));
  };

  const handleRouteAdd = () => {
    onRoutesChange([...proxyRoutes, { id: `route-${Date.now()}` }]);
  };

  const enabled = status?.enabled ?? false;
  const running = status?.running ?? false;
  const meshEnabled = meshStatus?.enabled ?? false;
  const meshRunning = meshStatus?.running ?? false;
  const proxyPort = status?.port ?? 4433;
  const localDomain = status?.localDomain ?? "";
  const normalizedDomain = normalizeLocalDomain(localDomain);
  const routeHosts = [...new Set(proxyRoutes.map((r) => normalizeLocalDomain(r.host || "")).filter(Boolean))];
  const previewRouteHost = routeHosts.find((host) => !host.startsWith("*."));
  const primaryHost = normalizedDomain || previewRouteHost || "localhost";
  const httpsUrl = formatHttpsOrigin(primaryHost, proxyPort);
  const certHosts = ["localhost", ...(normalizedDomain ? [normalizedDomain, `*.${normalizedDomain}`] : [])];
  const certPath = status?.certPath ?? null;
  const caCertPath = status?.caCertPath ?? null;

  // Collect unique hosts that need /etc/hosts entries
  // Include the localDomain itself if set
  const customHosts = [...new Set([...(normalizedDomain ? [normalizedDomain] : []), ...routeHosts.filter((h) => h !== "localhost")])];

  return (
    <SettingsSection
      icon={Network}
      title="Local Network Runtime"
      description="Detached infrastructure process that keeps the service mesh and HTTPS reverse proxy running even when Fifony is offline."
    >
      <div className="space-y-5">
        {error && (
          <div className="alert alert-error py-2 text-xs">
            <span className="font-mono">{error}</span>
          </div>
        )}

        <div className="rounded-xl border border-base-content/10 bg-base-200/40">
          <button
            type="button"
            className="w-full flex items-start justify-between gap-3 p-4 text-left"
            onClick={() => setMeshOpen((v) => !v)}
          >
            <div>
              <p className="text-sm font-semibold">Service Mesh</p>
              <p className="text-xs opacity-50 mt-0.5">Captures service-to-service HTTP(S) proxy traffic for the graph, observed protocol mix, request volume, and error rate.</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div>
                <p className="text-sm font-medium">Enable mesh</p>
                <p className="text-xs opacity-50 mt-0.5">
                  {meshRunning
                    ? <span className="text-success">Running</span>
                    : meshEnabled ? "Enabled in the shared network runtime" : "Disabled"}
                </p>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary toggle-sm"
                checked={meshEnabled}
                disabled={busy || meshStatus === null}
                onChange={(e) => {
                  e.stopPropagation();
                  handleMeshToggle(e.target.checked);
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <ChevronDown className={`size-4 opacity-40 transition-transform ${meshOpen ? "rotate-180" : ""}`} />
            </div>
          </button>

          {meshOpen && (
            <div className="px-4 pb-4 pt-0 border-t border-base-content/5">
              <div className="flex items-end gap-4 flex-wrap">
                <div className="flex items-end gap-1.5">
                  <label className="form-control">
                    <div className="label py-0.5"><span className="label-text text-xs">Mesh port</span></div>
                    <input
                      type="number"
                      className="input input-bordered input-sm font-mono text-xs w-24"
                      value={meshPortDraft}
                      min={0}
                      max={65535}
                      onChange={(e) => setMeshPortDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleMeshPortSave(); }}
                      placeholder="0"
                    />
                  </label>
                  <button className="btn btn-sm btn-ghost" onClick={handleMeshPortSave} disabled={busy} title="Save mesh port">
                    {meshPortSaved ? <Check className="size-3.5 text-success" /> : <Check className="size-3.5" />}
                  </button>
                </div>

                <div className="flex items-end gap-1.5">
                  <label className="form-control">
                    <div className="label py-0.5"><span className="label-text text-xs">Traffic buffer</span></div>
                    <input
                      type="number"
                      className="input input-bordered input-sm font-mono text-xs w-28"
                      value={meshBufferDraft}
                      min={100}
                      max={100000}
                      onChange={(e) => setMeshBufferDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleMeshBufferSave(); }}
                      placeholder="1000"
                    />
                  </label>
                  <button className="btn btn-sm btn-ghost" onClick={handleMeshBufferSave} disabled={busy} title="Save traffic buffer">
                    {meshBufferSaved ? <Check className="size-3.5 text-success" /> : <Check className="size-3.5" />}
                  </button>
                </div>

                <div className="flex items-end gap-1.5">
                  <label className="form-control">
                    <div className="label py-0.5"><span className="label-text text-xs">Live window (s)</span></div>
                    <input
                      type="number"
                      className="input input-bordered input-sm font-mono text-xs w-28"
                      value={meshWindowDraft}
                      min={30}
                      max={86400}
                      onChange={(e) => setMeshWindowDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleMeshWindowSave(); }}
                      placeholder="900"
                    />
                  </label>
                  <button className="btn btn-sm btn-ghost" onClick={handleMeshWindowSave} disabled={busy} title="Save live window">
                    {meshWindowSaved ? <Check className="size-3.5 text-success" /> : <Check className="size-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-base-content/10 bg-base-200/40">
          <button
            type="button"
            className="w-full flex items-start justify-between gap-3 p-4 text-left"
            onClick={() => setProxyOpen((v) => !v)}
          >
            <div>
              <p className="text-sm font-semibold">HTTPS Reverse Proxy</p>
              <p className="text-xs opacity-50 mt-0.5">Serve the dashboard over HTTPS with a self-signed certificate and route services by subdomain or path.</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div>
                <p className="text-sm font-medium">Enable HTTPS proxy</p>
                <p className="text-xs opacity-50 mt-0.5">
                  {running
                    ? <span className="text-success">Running</span>
                    : enabled ? "Enabled in the shared network runtime" : "Disabled"}
                </p>
              </div>
              <input
                type="checkbox"
                className="toggle toggle-primary toggle-sm"
                checked={enabled}
                disabled={busy || status === null}
                onChange={(e) => {
                  e.stopPropagation();
                  handleToggle(e.target.checked);
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <ChevronDown className={`size-4 opacity-40 transition-transform ${proxyOpen ? "rotate-180" : ""}`} />
            </div>
          </button>

          {proxyOpen && (
            <div className="px-4 pb-4 pt-0 border-t border-base-content/5 space-y-5">
          {/* Enable + port + domain row */}
          <div className="flex items-end gap-4 flex-wrap">
            <div className="flex items-end gap-1.5">
              <label className="form-control">
                <div className="label py-0.5"><span className="label-text text-xs">Local domain</span></div>
                <input
                  className="input input-bordered input-sm font-mono text-xs w-40"
                  value={domainDraft}
                  onChange={(e) => setDomainDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleDomainSave(); }}
                  placeholder="spark.local"
                />
              </label>
              <button className="btn btn-sm btn-ghost" onClick={handleDomainSave} disabled={busy} title="Save domain">
                {domainSaved ? <Check className="size-3.5 text-success" /> : <Check className="size-3.5" />}
              </button>
            </div>

            <div className="flex items-end gap-1.5">
              <label className="form-control">
                <div className="label py-0.5"><span className="label-text text-xs">Port</span></div>
                <input
                  type="number"
                  className="input input-bordered input-sm font-mono text-xs w-24"
                  value={portDraft}
                  min={1}
                  max={65535}
                  onChange={(e) => setPortDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handlePortSave(); }}
                  placeholder="4433"
                />
              </label>
              <button className="btn btn-sm btn-ghost" onClick={handlePortSave} disabled={busy} title="Save port">
                {portSaved ? <Check className="size-3.5 text-success" /> : <Check className="size-3.5" />}
              </button>
            </div>
          </div>

          <p className="text-[11px] opacity-45 -mt-2">
            Port <span className="font-mono">443</span> is valid. On Linux, binding privileged ports may require elevated privileges or <span className="font-mono">CAP_NET_BIND_SERVICE</span>.
          </p>

          {/* Live HTTPS URL */}
          {enabled && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-success/10 border border-success/20">
              <ShieldCheck className={`size-4 shrink-0 ${running ? "text-success" : "opacity-40"}`} />
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-mono ${running ? "text-success" : "opacity-60"}`}>{httpsUrl}</p>
                <p className="text-[11px] opacity-45 mt-0.5">
                  {running ? "Dashboard entrypoint over TLS" : "Configured entrypoint. Start the proxy to serve this address."}
                </p>
              </div>
              {running && (
                <a href={httpsUrl} target="_blank" rel="noopener noreferrer" className="btn btn-xs btn-ghost gap-1 text-success">
                  <ExternalLink className="size-3" /> Open
                </a>
              )}
            </div>
          )}

          {/* Route table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold opacity-50 uppercase tracking-wider">Routing rules</p>
            </div>

            {proxyRoutes.length > 0 && (
              <div>
                <div className="grid grid-cols-[1fr_1fr_1.5fr_auto] gap-2 px-0 pb-1">
                  <span className="text-[10px] opacity-30 uppercase tracking-wider">Host</span>
                  <span className="text-[10px] opacity-30 uppercase tracking-wider">Path prefix</span>
                  <span className="text-[10px] opacity-30 uppercase tracking-wider">Target</span>
                  <span />
                </div>
                {proxyRoutes.map((route, idx) => (
                  <ProxyRouteRow
                    key={route.id}
                    route={route}
                    services={services}
                    localDomain={normalizedDomain}
                    onChange={(updated) => handleRouteChange(idx, updated)}
                    onDelete={() => handleRouteDelete(idx)}
                  />
                ))}
              </div>
            )}

            <button className="btn btn-xs btn-ghost gap-1 opacity-50 hover:opacity-100" onClick={handleRouteAdd}>
              <Plus className="size-3" /> Add rule
            </button>

            {proxyRoutes.length === 0 && (
              <p className="text-xs opacity-30">
                No custom rules — all traffic goes to the dashboard. Add rules to route by subdomain or path.
              </p>
            )}
          </div>

          {/* /etc/hosts helper */}
          {customHosts.length > 0 && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-warning/10 border border-warning/20">
              <Info className="size-3.5 shrink-0 mt-0.5 text-warning" />
              <div className="space-y-1.5 flex-1 min-w-0">
                <p className="text-xs font-medium">Add to <span className="font-mono">/etc/hosts</span></p>
                <pre className="text-[11px] font-mono bg-base-300/60 rounded p-2 select-all leading-relaxed">
                  {customHosts.map((h) => `127.0.0.1  ${h}`).join("\n")}
                </pre>
                <p className="text-[11px] opacity-50">Required for custom domains to resolve locally. Run <span className="font-mono">sudo nano /etc/hosts</span>.</p>
              </div>
            </div>
          )}

          {/* Cert info */}
          {enabled && certPath && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-base-300/50">
              <Info className="size-3.5 shrink-0 mt-0.5 opacity-40" />
              <div className="text-xs opacity-50 space-y-1">
                <p>
                  Cert covers: {certHosts.map((host, idx) => (
                    <span key={host} className="font-mono">
                      {idx === 0 ? "" : ", "}{host}
                    </span>
                  ))}
                </p>
                {caCertPath && (
                  <p>
                    To trust in browser/OS: import the CA cert at <span className="font-mono select-all">{caCertPath}</span>
                  </p>
                )}
                <p>Or open the HTTPS URL in Chrome and proceed past the warning.</p>
              </div>
            </div>
          )}
            </div>
          )}
        </div>

        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-base-300/40">
          <Info className="size-3.5 shrink-0 mt-0.5 opacity-40" />
          <div className="text-xs opacity-50 space-y-1">
            <p>The mesh and HTTPS proxy share one detached network runtime process.</p>
            <p>Stopping Fifony does not stop this runtime. When Fifony comes back, it reconciles the runtime state, port, and log automatically.</p>
            <p>Logs are available in <span className="font-mono">/services</span> under the runtime services.</p>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

function ServicesSettings() {
  const { liveMode } = useDashboard();
  const { services, loading: servicesLoading, refresh } = useServices({ liveMode, pollInterval: liveMode ? false : 30_000 });
  const variablesQuery = useVariables();
  const variables = getVariablesList(variablesQuery.data);
  const { upsert, remove } = useVariableMutations();
  const servicesRefresh = useCallback(() => refresh(), [refresh]);
  const [addingNew, setAddingNew] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectedSuggestions, setDetectedSuggestions] = useState([]);
  const [proxyRoutes, setProxyRoutes] = useState([]);

  // Load initial routes
  useEffect(() => {
    api.get("/proxy/reverse/status").then((res) => {
      if (res?.routes) setProxyRoutes(res.routes);
    }).catch(() => {});
  }, []);

  const handleProxyRoutesChange = useCallback(async (newRoutes) => {
    setProxyRoutes(newRoutes);
    try { await api.put("/proxy/reverse/routes", { routes: newRoutes }); } catch {}
  }, []);

  const handleVariableUpdate = useCallback(async (oldKey, newKey, value, scope) => {
    if (oldKey !== newKey) {
      await remove(`${scope}:${oldKey}`);
    }
    await upsert(newKey, value, scope);
  }, [upsert, remove]);

  const handleServiceSave = useCallback(async (entry) => {
    await api.put(`/services/${entry.id}`, entry);
    await servicesRefresh();
  }, [servicesRefresh]);

  const handleServiceAssignPort = useCallback(async (entry) => {
    await api.post(`/services/${entry.id}/assign-port`, {});
    await servicesRefresh();
  }, [servicesRefresh]);

  const handleServiceDelete = useCallback(async (id) => {
    await api.delete(`/services/${id}`);
    await servicesRefresh();
  }, [servicesRefresh]);

  const handleServiceAdd = useCallback(async (entry) => {
    await api.put(`/services/${entry.id}`, entry);
    await servicesRefresh();
    setAddingNew(false);
    setDetectedSuggestions([]);
  }, [servicesRefresh]);

  const handleDetectFromEmpty = useCallback(async () => {
    setDetecting(true);
    try {
      const res = await api.get("/services/detect");
      const sugs = res?.suggestions ?? [];
      setDetectedSuggestions(sugs);
      if (sugs.length > 0) setAddingNew(true);
    } finally {
      setDetecting(false);
    }
  }, []);

  return (
    <div className="space-y-4">

      {/* HTTPS Reverse Proxy */}
      <ReverseProxySection services={services} proxyRoutes={proxyRoutes} onRoutesChange={handleProxyRoutesChange} />

      {/* Global variables */}
      <SettingsSection
        icon={Globe}
        title="Global variables"
        description="Environment variables injected into every service on start. Per-service variables below take precedence. Changes take effect on the next restart."
      >
        {variablesQuery.isLoading ? (
          <div className="flex items-center gap-2 opacity-40"><Loader2 className="size-3 animate-spin" /><span className="text-xs">Loading...</span></div>
        ) : (
          <VariablesList
            scope="global"
            variables={variables}
            onUpdate={handleVariableUpdate}
            onDelete={remove}
            onAdd={upsert}
          />
        )}
      </SettingsSection>

      {/* Services */}
      <SettingsSection
        icon={Server}
        title="Services"
        description="Dev servers and background processes managed by Spark. Start and view logs from the Services page."
      >
        {servicesLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 rounded-lg bg-base-300 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {services.length === 0 && !addingNew && (
              <EmptyServicesState
                onAdd={() => setAddingNew(true)}
                onDetect={handleDetectFromEmpty}
                detecting={detecting}
              />
            )}

            {/* Show detected suggestions at top level when triggered from empty state */}
            {detectedSuggestions.length > 0 && addingNew && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                <span className="text-xs opacity-60">Detected services — click to fill the form:</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {detectedSuggestions.map((s, i) => (
                    <DetectedServiceCard
                      key={i}
                      suggestion={s}
                      onSelect={(sug) => {
                        // Auto-fill and submit directly from detected suggestion
                        const slug = sug.command.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
                        const id = `${slug}-${Date.now()}`;
                        handleServiceAdd({
                          id,
                          name: sug.label,
                          command: sug.command,
                          cwd: sug.cwd || undefined,
                          port: sug.port ?? undefined,
                          autoStart: false,
                          autoRestart: false,
                        });
                      }}
                    />
                  ))}
                </div>
                <button className="text-xs opacity-40 hover:opacity-70" onClick={() => { setDetectedSuggestions([]); }}>dismiss</button>
              </div>
            )}

            {services.map((svc) => (
              <ServiceConfigCard
                key={svc.id}
                service={svc}
                variables={variables}
                onSave={handleServiceSave}
                onDelete={handleServiceDelete}
                onAssignPort={handleServiceAssignPort}
                onVariableUpdate={handleVariableUpdate}
                onVariableDelete={remove}
                onVariableAdd={upsert}
                proxyRoutes={proxyRoutes}
                onProxyRoutesChange={handleProxyRoutesChange}
              />
            ))}
            {addingNew && !detectedSuggestions.length
              ? <AddServiceForm onAdd={handleServiceAdd} onCancel={() => setAddingNew(false)} />
              : services.length > 0 && !addingNew && (
                <button className="btn btn-xs btn-ghost gap-1 opacity-60 hover:opacity-100" onClick={() => setAddingNew(true)}>
                  <Plus className="size-3" /> Add service
                </button>
              )
            }
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
