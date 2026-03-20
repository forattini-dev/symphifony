import { ChevronRight, Sparkles } from "lucide-react";

function WelcomeStep({ workspacePath, onGetStarted }) {
  return (
    <div className="flex flex-col items-center text-center gap-6 stagger-children py-4">
      <img
        src="/dinofffaur.png"
        alt="fifony mascot"
        className="h-72 sm:h-96 object-contain animate-bounce-in select-none pointer-events-none"
        style={{ filter: "drop-shadow(0 12px 40px rgba(128, 0, 255, 0.3))" }}
      />
      <h1
        className="text-4xl sm:text-5xl font-bold tracking-tight leading-none"
        style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
      >
        Welcome to <span className="text-primary">fifony</span>
      </h1>
      <p className="text-base-content/60 text-lg max-w-md">
        Let's set up your AI orchestration project in just a few steps.
      </p>
      {workspacePath && (
        <div className="badge badge-lg badge-soft badge-primary gap-2">
          <Sparkles className="size-3.5" />
          Project target: {workspacePath}
        </div>
      )}
      <button
        className="btn btn-primary btn-lg gap-2 mt-2"
        onClick={onGetStarted}
      >
        Get Started <ChevronRight className="size-5" />
      </button>
    </div>
  );
}

export default WelcomeStep;
