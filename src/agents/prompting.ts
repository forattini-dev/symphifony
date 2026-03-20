import { TemplateEngine } from "recker";
import { PROMPT_TEMPLATES, type PromptTemplateName } from "./generated/prompts.ts";

const engine = new TemplateEngine({
  cache: true,
  format: "raw",
  strict: false,
});

function normalizePrompt(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function renderPrompt(
  name: PromptTemplateName,
  context: Record<string, unknown> = {},
): Promise<string> {
  return renderPromptString(PROMPT_TEMPLATES[name], context);
}

export async function renderPromptString(
  template: string,
  context: Record<string, unknown> = {},
): Promise<string> {
  const rendered = await engine.render(template, context);
  return normalizePrompt(rendered);
}
