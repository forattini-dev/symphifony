/**
 * Extracts structured insights from raw CLI output when an execution fails.
 * These insights are injected into the retry prompt to help the agent learn
 * from previous failures and try a different approach.
 */

export type FailureInsight = {
  /** Categorized failure type */
  errorType: "typescript" | "test" | "lint" | "runtime" | "build" | "git" | "timeout" | "process" | "unknown";
  /** The specific error message (cleaned, deduplicated) */
  errorMessage: string;
  /** The command that failed (if detectable) */
  failedCommand?: string;
  /** File paths mentioned in the error */
  filesInvolved: string[];
  /** A one-line root cause summary */
  rootCause: string;
  /** Actionable guidance for the next attempt */
  suggestion: string;
};

/** Extract file paths from output (src/foo.ts, ./bar.js, tests/x.test.ts) */
function extractFilePaths(output: string): string[] {
  const pathRegex = /(?:^|\s|["'(])([.\w/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html|vue|svelte))\b/gm;
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(output)) !== null) {
    const p = match[1];
    if (p && !p.startsWith("http") && !p.includes("node_modules") && p.includes("/")) {
      paths.add(p);
    }
  }
  return [...paths].slice(0, 10);
}

/** Extract the first meaningful error line */
function extractErrorLine(output: string): string {
  const patterns = [
    // Specific error codes first (most informative)
    /error\s+TS\d+:\s*(.+)/m,
    /^AssertionError.*:\s*(.+)$/m,
    /^CONFLICT\s*(.+)$/m,
    /^fatal:\s*(.+)$/m,
    /ERR!\s*(.+)$/m,
    // Generic error types
    /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):\s*(.+)$/m,
    /^(?:FAIL|FAILED)\s+(.+)$/m,
    /^error:\s*(.+)$/m,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[0].trim().slice(0, 200);
  }

  // Fallback: find a line that looks like an error
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && /error|fail|cannot|unable|not found|unexpected/i.test(trimmed)) {
      return trimmed.slice(0, 200);
    }
  }

  return "";
}

/** Detect which command failed from output patterns */
function detectFailedCommand(output: string): string | undefined {
  // pnpm/npm script failures
  const scriptMatch = output.match(/(?:pnpm|npm|yarn)\s+(?:run\s+)?(\w+).*(?:failed|error|ELIFECYCLE)/im)
    || output.match(/(?:pnpm|npm|yarn)\s+(\w+)\s+failed/im);
  if (scriptMatch) return `pnpm ${scriptMatch[1]}`;

  // Specific tool failures
  if (/error\s+TS\d+/m.test(output)) return "tsc (TypeScript compiler)";
  if (/eslint/i.test(output) && /error/i.test(output)) return "eslint";
  if (/jest|vitest|mocha|node --test/i.test(output) && /fail/i.test(output)) return "test runner";
  if (/git\s+(merge|rebase|push|pull)/i.test(output) && /fatal|error|conflict/i.test(output)) {
    const gitMatch = output.match(/git\s+(merge|rebase|push|pull)/i);
    return gitMatch ? `git ${gitMatch[1]}` : "git";
  }
  if (/SIGTERM|SIGKILL|timed?\s*out/i.test(output)) return "process (timeout/killed)";

  return undefined;
}

/** Try to extract readable text content from JSON-wrapped CLI output. */
function unwrapJsonOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed === "object" && parsed !== null) {
      // Claude: result field contains the text
      if (typeof parsed.result === "string") return parsed.result;
      // Gemini: response field contains the text
      if (typeof parsed.response === "string") return parsed.response;
      // Claude structured_output
      if (parsed.structured_output?.summary) return String(parsed.structured_output.summary);
    }
  } catch {
    // Not JSON — return as-is
  }
  return raw;
}

/** Analyze raw CLI output and extract structured failure insights. */
export function extractFailureInsights(output: string, exitCode?: number | null): FailureInsight {
  // Unwrap JSON envelope so patterns match against the actual text content
  const normalizedOutput = output ? `${unwrapJsonOutput(output)}\n${output}` : "";

  // Detect error type — order matters! More specific patterns first.
  let errorType: FailureInsight["errorType"] = "unknown";
  if (/error\s+TS\d+/m.test(normalizedOutput)) {
    errorType = "typescript";
  } else if (/eslint|ESLint/m.test(normalizedOutput) && /error/m.test(normalizedOutput)) {
    // Lint check before test — eslint output also contains ✖ which would match test pattern
    errorType = "lint";
  } else if (/(?:CONFLICT|Merge conflict)/im.test(normalizedOutput)) {
    // Git conflicts before generic patterns
    errorType = "git";
  } else if (/(?:FAIL\s|AssertionError|test.*failed|expect.*received)/im.test(normalizedOutput)) {
    // Test failures — FAIL with trailing space to avoid "failed" false positives
    errorType = "test";
  } else if (/(?:SIGTERM|SIGKILL|timed?\s*out|killed)/im.test(normalizedOutput)) {
    errorType = "timeout";
  } else if (/(?:ELIFECYCLE|ERR!|build.*fail)/im.test(normalizedOutput)) {
    errorType = "build";
  } else if (/(?:fatal:\s)/m.test(normalizedOutput)) {
    errorType = "git";
  } else if (/(?:Error:|TypeError:|ReferenceError:|SyntaxError:)/m.test(normalizedOutput)) {
    errorType = "runtime";
  } else if (exitCode && exitCode !== 0) {
    errorType = "process";
  }

  const errorMessage = extractErrorLine(normalizedOutput);
  const failedCommand = detectFailedCommand(normalizedOutput);
  const filesInvolved = extractFilePaths(normalizedOutput);

  // Build root cause summary
  let rootCause: string;
  switch (errorType) {
    case "typescript":
      rootCause = `TypeScript compilation failed${filesInvolved.length ? ` in ${filesInvolved[0]}` : ""}`;
      break;
    case "test":
      rootCause = `Test assertion failed${filesInvolved.length ? ` in ${filesInvolved[0]}` : ""}`;
      break;
    case "lint":
      rootCause = "Lint rules violated";
      break;
    case "timeout":
      rootCause = "Process timed out or was killed";
      break;
    case "build":
      rootCause = "Build/install step failed";
      break;
    case "git":
      rootCause = "Git operation failed (possible conflict or dirty state)";
      break;
    case "runtime":
      rootCause = `Runtime error: ${errorMessage.slice(0, 80)}`;
      break;
    case "process":
      rootCause = `Process exited with code ${exitCode}`;
      break;
    default:
      rootCause = errorMessage ? `Error: ${errorMessage.slice(0, 80)}` : "Unknown failure";
  }

  // Build actionable suggestion
  let suggestion: string;
  switch (errorType) {
    case "typescript":
      suggestion = "Check type signatures and imports. The previous approach introduced a type error — try a different API surface.";
      break;
    case "test":
      suggestion = "The implementation broke existing tests. Read the test file first, understand the expected behavior, then fix the implementation to match.";
      break;
    case "lint":
      suggestion = "Run the linter before finishing. Fix formatting and rule violations.";
      break;
    case "timeout":
      suggestion = "The previous approach was too slow or hung. Simplify the approach or break it into smaller steps.";
      break;
    case "build":
      suggestion = "A dependency or build step failed. Check package.json and verify imports.";
      break;
    case "git":
      suggestion = "A git operation failed. Check for merge conflicts, uncommitted changes, or branch state.";
      break;
    case "runtime":
      suggestion = "The code threw an error at runtime. Check for null/undefined, missing imports, or wrong API usage.";
      break;
    default:
      suggestion = "Review the full error output and try a fundamentally different approach.";
  }

  return {
    errorType,
    errorMessage,
    failedCommand,
    filesInvolved,
    rootCause,
    suggestion,
  };
}

