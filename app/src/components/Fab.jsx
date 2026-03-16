import { Plus } from "lucide-react";

export function Fab({ onClick }) {
  return (
    <button
      className="fixed right-6 bottom-24 sm:bottom-6 z-30 btn btn-circle btn-lg btn-primary shadow-lg animate-fab-breathe hover:scale-110 hover:rotate-90 active:scale-95 active:rotate-0 transition-all duration-300 group"
      onClick={onClick}
      aria-label="Create new issue"
    >
      <Plus className="size-6 transition-transform duration-300 group-hover:rotate-90" />
      <span className="absolute -top-8 right-0 text-xs bg-base-300 text-base-content px-2 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap shadow-md">
        New Issue
      </span>
    </button>
  );
}

export default Fab;
