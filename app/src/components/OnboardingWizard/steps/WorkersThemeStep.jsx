import { Users, Palette } from "lucide-react";
import { THEMES } from "../constants";

// Swatch colors: [bgHex, accentHex]
const THEME_SWATCHES = {
  auto:    { bg: null, label: "Auto" },
  light:   { bg: "#ffffff", accent: "#7c3aed" },
  dark:    { bg: "#1d232a", accent: "#661ae6" },
  black:   { bg: "#000000", accent: "#ffffff" },
  cupcake: { bg: "#faf7f5", accent: "#ef9fbc" },
  night:   { bg: "#0f172a", accent: "#38bdf8" },
  sunset:  { bg: "#1a1019", accent: "#ff865b" },
};

function ThemeSwatch({ theme, selected, onClick }) {
  const swatch = THEME_SWATCHES[theme.value];
  return (
    <button
      onClick={onClick}
      title={theme.label}
      className={`flex flex-col items-center gap-1.5 group focus:outline-none`}
    >
      <div
        className={`w-10 h-10 rounded-xl border-2 transition-all overflow-hidden flex-shrink-0 ${
          selected
            ? "border-primary ring-2 ring-primary ring-offset-2 ring-offset-base-200 scale-110"
            : "border-base-300 group-hover:border-base-content/30 group-hover:scale-105"
        }`}
        style={swatch.bg ? { background: swatch.bg } : undefined}
      >
        {swatch.bg ? (
          /* bottom accent strip */
          <div className="w-full h-full flex flex-col">
            <div className="flex-1" style={{ background: swatch.bg }} />
            <div className="h-3 w-full" style={{ background: swatch.accent }} />
          </div>
        ) : (
          /* Auto: half light / half dark */
          <div className="w-full h-full flex">
            <div className="flex-1 bg-white" />
            <div className="flex-1 bg-neutral" />
          </div>
        )}
      </div>
      <span className={`text-xs font-medium transition-colors ${selected ? "text-primary" : "text-base-content/50 group-hover:text-base-content/80"}`}>
        {theme.label}
      </span>
    </button>
  );
}

function WorkersThemeStep({ concurrency, setConcurrency, selectedTheme, setSelectedTheme }) {
  const safeConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.min(10, concurrency)) : 1;

  return (
    <div className="flex flex-col gap-6 stagger-children">
      <div className="text-center">
        <Users className="size-10 text-primary mx-auto mb-3" />
        <h2 className="text-2xl font-bold">Workers & Theme</h2>
        <p className="text-base-content/60 mt-1 text-sm">Configure parallel workers and visual theme</p>
      </div>

      {/* Concurrency */}
      <div className="card bg-base-200">
        <div className="card-body p-5 gap-3">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Users className="size-4 opacity-50" />
            Worker Concurrency
          </h3>
          <p className="text-xs text-base-content/60">
            How many agents can work in parallel ({safeConcurrency} worker{safeConcurrency !== 1 ? "s" : ""})
          </p>
          <div className="w-full max-w-xs">
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={safeConcurrency}
              onChange={(e) => setConcurrency(Math.round(Number(e.target.value)))}
              aria-label="Number of parallel workers"
              className="range range-primary range-sm w-full"
            />
            <div className="flex justify-between px-2.5 mt-2 text-xs">
              {Array.from({ length: 10 }, (_, index) => (
                <span key={index}>|</span>
              ))}
            </div>
            <div className="flex justify-between px-2.5 mt-2 text-xs">
              {Array.from({ length: 10 }, (_, index) => (
                <span key={index}>{index + 1}</span>
              ))}
            </div>
          </div>
          <p className="text-xs text-base-content/50 bg-base-100 rounded-lg px-3 py-2 mt-1">
            <span className="font-medium text-base-content/70">Tip:</span> 2–4 workers is recommended for most projects. More workers consume more API quota and may hit rate limits.
          </p>
        </div>
      </div>

      {/* Theme */}
      <div className="card bg-base-200">
        <div className="card-body p-5 gap-4">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Palette className="size-4 opacity-50" />
            Theme
          </h3>
          <div className="flex flex-wrap gap-5 justify-center py-1">
            {THEMES.map((t) => (
              <ThemeSwatch
                key={t.value}
                theme={t}
                selected={selectedTheme === t.value}
                onClick={() => setSelectedTheme(t.value)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default WorkersThemeStep;
